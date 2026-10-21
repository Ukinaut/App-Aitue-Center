import { randomUUID } from 'node:crypto';
import {initializeGbPeriods,renewGbCycles,gbChannel,gbToday,createGbCycle,setGbPlan,gbPlanChange} from './gb-periods.mjs';
export const GB_APP = 'aitue-gestion-gb';
function nextInternalNumber(db) {
  let n=1;
  while(db.prepare('SELECT 1 FROM gb_devices WHERE internal_number=? COLLATE NOCASE').get(`GB-${String(n).padStart(6,'0')}`))n++;
  return `GB-${String(n).padStart(6,'0')}`;
}
export function initializeGb(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS gb_sims(id TEXT PRIMARY KEY, number TEXT UNIQUE NOT NULL, operator TEXT NOT NULL, capacity INTEGER NOT NULL CHECK(capacity>=0), owner_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS gb_devices(id TEXT PRIMARY KEY, kit TEXT UNIQUE NOT NULL, name TEXT NOT NULL, sim_id TEXT UNIQUE REFERENCES gb_sims(id), capacity INTEGER NOT NULL CHECK(capacity>=0), allocated INTEGER NOT NULL CHECK(allocated>=0), owner_id TEXT NOT NULL REFERENCES users(id), active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS gb_usage(id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES gb_devices(id), amount INTEGER NOT NULL CHECK(amount>0), date TEXT NOT NULL, note TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS gb_usage_device_date ON gb_usage(device_id,date);`);
  // Convertir el modelo anterior sin perder saldos ni atribuir consumos a otra red.
  db.exec('BEGIN IMMEDIATE');
  try {
    if(!db.prepare('PRAGMA table_info(gb_devices)').all().some(c=>c.name==='satellite_enabled')){
      db.exec(`ALTER TABLE gb_devices ADD COLUMN satellite_enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE gb_devices ADD COLUMN satellite_allocated INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE gb_devices ADD COLUMN sim_allocated INTEGER NOT NULL DEFAULT 0;
      UPDATE gb_devices SET satellite_enabled=CASE WHEN sim_id IS NULL THEN 1 ELSE 0 END,
      satellite_allocated=CASE WHEN sim_id IS NULL THEN allocated ELSE 0 END,
      sim_allocated=CASE WHEN sim_id IS NOT NULL THEN allocated ELSE 0 END;`);
    }
    if(!db.prepare('PRAGMA table_info(gb_usage)').all().some(c=>c.name==='source')){
      db.exec(`ALTER TABLE gb_usage ADD COLUMN source TEXT NOT NULL DEFAULT 'satellite' CHECK(source IN ('satellite','sim'));
      UPDATE gb_usage SET source=CASE WHEN (SELECT sim_id FROM gb_devices WHERE id=device_id) IS NULL THEN 'satellite' ELSE 'sim' END;`);
    }
    if(!db.prepare('PRAGMA table_info(gb_devices)').all().some(c=>c.name==='controller_id')){
      db.exec(`ALTER TABLE gb_devices ADD COLUMN controller_id TEXT REFERENCES users(id);
      UPDATE gb_devices SET controller_id=owner_id WHERE owner_id IN (SELECT id FROM users WHERE role='controlador');`);
    }
    if(!db.prepare('PRAGMA table_info(gb_devices)').all().some(c=>c.name==='internal_number'))db.exec('ALTER TABLE gb_devices ADD COLUMN internal_number TEXT');
    for(const d of db.prepare('SELECT id FROM gb_devices WHERE internal_number IS NULL ORDER BY rowid').all())db.prepare('UPDATE gb_devices SET internal_number=? WHERE id=?').run(nextInternalNumber(db),d.id);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS gb_devices_internal_number ON gb_devices(internal_number COLLATE NOCASE)');
    db.exec('CREATE INDEX IF NOT EXISTS gb_devices_controller ON gb_devices(controller_id)');
    db.exec('COMMIT');
  } catch(error){db.exec('ROLLBACK');throw error;}
  initializeGbPeriods(db);
  db.prepare('INSERT OR IGNORE INTO apps VALUES (?,?,?,?,?)').run(GB_APP,'Gestión de GB','Dispositivos, SIM cards, asignaciones y reportes de consumo.','/?app=gestion-gb','blue');
}
const amount = (value, label, positive = false) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10000000 || (positive && value <= 0) || Math.abs(value * 1000 - Math.round(value * 1000)) > .00001) throw Object.assign(new Error(`${label}: ingresá un valor ${positive?'mayor que cero':'no negativo'} con hasta 3 decimales.`),{status:400});
  return Math.round(value * 1000);
};
const text = (value, label, max = 100, required = true) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw Object.assign(new Error(`Revisá ${label}.`),{status:400});
  return value.trim();
};
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10)!==value) throw Object.assign(new Error('Fecha inválida.'),{status:400});
  return value;
}
export function handleGb({db,actor,users,url,method,b,send,fail,transaction,log,now=Date.now()}) {
  if (!url.pathname.startsWith('/api/gb/')) return false;
  if(actor.role!=='superadmin'&&!actor.apps.includes(GB_APP))fail(403,'No tenés acceso a Gestión de GB.');
  renewGbCycles(db,now);
  const manager=['superadmin','admin'].includes(actor.role), writer=manager||actor.role==='controlador';
  const scope=new Set(manager?users.map(u=>u.id):[actor.id]);
  const visible=d=>manager||(actor.role==='controlador'?d.controller_id===actor.id:d.owner_id===actor.id);
  const own = record => {if(!record||!visible(record))fail(404,'Registro no encontrado en tu alcance.');return record;};
  const owners=users.filter(u=>scope.has(u.id)&&u.active&&(u.role==='superadmin'||u.apps.includes(GB_APP)));
  const owner = id => {if(!owners.some(u=>u.id===id))fail(400,'Seleccioná una persona activa de tu equipo con acceso a esta aplicación.');return id;};
  const controllers=manager?users.filter(u=>u.role==='controlador'&&u.active&&u.apps.includes(GB_APP)):[];
  const controller=id=>{if(id!==null&&!controllers.some(u=>u.id===id))fail(400,'Seleccioná un controlador activo con acceso a Gestión de GB.');return id;};
  const rawDevices=db.prepare(`SELECT d.*,s.number sim_number,s.operator,s.capacity sim_capacity,
  COALESCE((SELECT SUM(amount) FROM gb_usage WHERE device_id=d.id),0) used,
  COALESCE((SELECT SUM(amount) FROM gb_usage WHERE device_id=d.id AND source='satellite'),0) satellite_used,
  COALESCE((SELECT SUM(amount) FROM gb_usage WHERE device_id=d.id AND source='sim'),0) sim_used
  FROM gb_devices d LEFT JOIN gb_sims s ON s.id=d.sim_id ORDER BY d.created_at DESC`).all().map(d=>{
    const satellite=gbChannel(db,d,'satellite',now),sim=gbChannel(db,d,'sim',now);
    return {...d,capacity:satellite.capacity,sim_capacity:sim.capacity,satellite_allocated:satellite.allocated,sim_allocated:sim.allocated,allocated:satellite.allocated+sim.allocated,satellite_used:satellite.used,sim_used:sim.used,used:satellite.used+sim.used,periods:{satellite,sim}};
  });
  const devices=rawDevices.filter(visible),deviceIds=new Set(devices.map(d=>d.id));
  const sims=db.prepare(`SELECT s.*,d.kit,d.id device_id,d.owner_id device_owner,COALESCE((SELECT SUM(u.amount) FROM gb_usage u JOIN gb_devices d2 ON d2.id=u.device_id WHERE d2.sim_id=s.id AND u.source='sim'),0) used FROM gb_sims s LEFT JOIN gb_devices d ON d.sim_id=s.id ORDER BY s.created_at DESC`).all().map(s=>{const d=rawDevices.find(d=>d.id===s.device_id);return d?{...s,capacity:d.sim_capacity,used:d.sim_used}:s;}).filter(s=>manager||deviceIds.has(s.device_id));
  const balance=(capacity,allocated,used)=>({capacity:capacity/1000,allocated:allocated/1000,used:used/1000,remaining:(allocated-used)/1000,plan_remaining:(capacity-used)/1000});
  // La identidad se reemplaza en el servidor: tampoco viaja en JSON ni exportaciones.
  const identity=d=>({internal_number:d.internal_number,kit:manager?d.kit:d.internal_number,name:manager?d.name:'Equipo con identificación interna',sim_number:manager?d.sim_number:(d.sim_id?'Reservada':null)});
  const serializeDevice=d=>({...d,...identity(d),controller_name:users.find(u=>u.id===d.controller_id)?.name||null,capacity:((d.satellite_enabled?d.capacity:0)+(d.sim_capacity||0))/1000,allocated:d.allocated/1000,used:d.used/1000,remaining:(d.allocated-d.used)/1000,active:!!d.active,satellite:{mode:d.periods.satellite.mode,cycle:d.periods.satellite.cycle,auto_renew:d.periods.satellite.auto_renew,template:d.periods.satellite.template,enabled:!!d.satellite_enabled,...balance(d.satellite_enabled?d.capacity:0,d.satellite_allocated,d.satellite_used)},sim:{mode:d.periods.sim.mode,cycle:d.periods.sim.cycle,auto_renew:d.periods.sim.auto_renew,template:d.periods.sim.template,enabled:!!d.sim_id,...balance(d.sim_capacity||0,d.sim_allocated,d.sim_used)}});
  const serializeSim=s=>({...s,...(!manager?{number:'Reservada',kit:devices.find(d=>d.id===s.device_id)?.internal_number||null}:{}),can_edit:manager&&scope.has(s.owner_id)&&(!s.device_id||scope.has(s.device_owner)),capacity:s.capacity/1000,used:s.used/1000,remaining:(s.capacity-s.used)/1000});
  const serializeUsage=u=>{const d=devices.find(d=>d.id===u.device_id);return {...u,...identity(d),sim_number:u.source==='sim'?identity(d).sim_number:null,note:manager?u.note:'',original_amount:u.amount/1000,amount:(u.effective_amount??u.amount)/1000,corrected:!!u.correction_count,cycle_label:u.cycle_id?(db.prepare('SELECT start_date,end_date FROM gb_cycles WHERE id=?').get(u.cycle_id)?.start_date+' → '+db.prepare('SELECT end_date FROM gb_cycles WHERE id=?').get(u.cycle_id)?.end_date):'Acumulado anterior'};};
  const route=url.pathname.slice('/api/gb/'.length);
  const periodRoute=route.match(/^devices\/([^/]+)\/cycles(?:\/(satellite|sim)\/(start|renew|settings|plan))?$/);
  if(periodRoute){
    const device=own(rawDevices.find(d=>d.id===periodRoute[1]));
    if(!periodRoute[2]&&method==='GET'){
      const cycles=db.prepare(`SELECT c.*,a.name actor_name,COALESCE((SELECT SUM(effective_amount) FROM gb_usage_effective WHERE cycle_id=c.id),0) used FROM gb_cycles c LEFT JOIN users a ON a.id=c.actor_id WHERE device_id=? ORDER BY start_date DESC,source`).all(device.id).map(c=>({...c,capacity:c.capacity/1000,allocated:c.allocated/1000,used:c.used/1000,status:c.end_date<=gbToday(now)?'ended':c.start_date>gbToday(now)?'future':'current',actor_name:c.actor_name||'Sistema automático'}));
      const changes=manager?db.prepare('SELECT p.*,a.name actor_name FROM gb_plan_changes p LEFT JOIN users a ON a.id=p.actor_id WHERE p.device_id=? ORDER BY p.created_at DESC,p.rowid DESC').all(device.id).map(p=>({...p,capacity:p.capacity/1000,allocated:p.allocated/1000,before_capacity:p.before_capacity===null?null:p.before_capacity/1000,before_allocated:p.before_allocated===null?null:p.before_allocated/1000,actor_name:p.actor_name||'Sistema automático'})):[];
      return send(200,{device:serializeDevice(device),cycles,changes});
    }
    if(!manager)fail(403,'Solo los administradores gestionan planes y períodos.');
    const source=periodRoute[2],action=periodRoute[3];if(!source)fail(405,'Método no permitido.');
    if(source==='sim'&&!device.sim_id||source==='satellite'&&!device.satellite_enabled)fail(400,'La conexión no está habilitada en el equipo.');
    const latest=db.prepare('SELECT * FROM gb_cycles WHERE device_id=? AND source=? ORDER BY start_date DESC LIMIT 1').get(device.id,source),setting=db.prepare('SELECT * FROM gb_cycle_settings WHERE device_id=? AND source=?').get(device.id,source);
    const readPlan=()=>{const capacity=amount(b.capacity,'GB del plan'),allocated=amount(b.allocated,'GB asignados');if(allocated>capacity)fail(400,'La asignación no puede superar los GB del plan.');return {capacity,allocated};};
    if(action==='start'&&method==='POST'){
      if(latest)fail(409,'La conexión ya tiene ciclos mensuales.');
      const start=date(b.start_date);if(start!==gbToday(now))fail(400,'El primer período comienza hoy. El historial anterior queda como acumulado anterior.');
      if(typeof b.auto_renew!=='boolean'||!Number.isInteger(b.anchor_day)||b.anchor_day<1||b.anchor_day>31)fail(400,'Revisá el día de renovación y la renovación automática.');
      const plan=readPlan();transaction(()=>{db.prepare('INSERT INTO gb_legacy_plans VALUES (?,?,?,?)').run(device.id,source,device.periods[source].capacity,device.periods[source].allocated);db.prepare('INSERT INTO gb_cycle_settings VALUES (?,?,?,?,?,?)').run(device.id,source,b.anchor_day,Number(b.auto_renew),plan.capacity,plan.allocated);createGbCycle(db,device,source,start,{...plan,anchor_day:b.anchor_day},{actor_id:actor.id,now,action:'start'});log(actor,'Activó ciclos mensuales de GB',device.internal_number+' · '+source);});return send(201,{ok:true});
    }
    if(action==='renew'&&method==='POST'){
      if(!latest||!setting)fail(400,'Primero activá los ciclos mensuales.');if(latest.end_date>gbToday(now))fail(400,'El período actual todavía no terminó. Podés ampliar su plan sin reiniciar consumos.');
      transaction(()=>{let period=latest,count=0;while(period.end_date<=gbToday(now)&&count++<120){createGbCycle(db,device,source,period.end_date,setting,{actor_id:actor.id,now});period=db.prepare('SELECT * FROM gb_cycles WHERE device_id=? AND source=? ORDER BY start_date DESC LIMIT 1').get(device.id,source);}log(actor,'Renovó un período de GB',device.internal_number+' · '+source);});return send(200,{ok:true});
    }
    if(action==='settings'&&method==='PATCH'){
      if(!setting)fail(400,'Primero activá los ciclos mensuales.');if(typeof b.auto_renew!=='boolean')fail(400,'Indicá si la renovación será automática.');
      const plan=readPlan(),reason=text(b.reason,'el motivo del cambio',500);transaction(()=>{db.prepare('UPDATE gb_cycle_settings SET auto_renew=?,capacity=?,allocated=? WHERE device_id=? AND source=?').run(Number(b.auto_renew),plan.capacity,plan.allocated,device.id,source);gbPlanChange(db,{device_id:device.id,source,action:'template',before_capacity:setting.capacity,before_allocated:setting.allocated,...plan,actor_id:actor.id,reason,now});log(actor,'Configuró renovación de GB',device.internal_number+' · '+source);});return send(200,{ok:true});
    }
    if(action==='plan'&&method==='PATCH'){
      const current=device.periods[source];if(current.mode==='expired')fail(400,'Renová el período vencido antes de cambiar su plan.');
      const plan=readPlan(),reason=text(b.reason,'el motivo del cambio',500);if(plan.allocated<current.used)fail(400,'La asignación no puede ser menor al consumo registrado del período.');
      transaction(()=>{setGbPlan(db,device,source,plan.capacity,plan.allocated);if(current.cycle)db.prepare('UPDATE gb_cycles SET capacity=?,allocated=? WHERE id=?').run(plan.capacity,plan.allocated,current.cycle.id);gbPlanChange(db,{device_id:device.id,source,cycle_id:current.cycle?.id||null,action:'plan',before_capacity:current.capacity,before_allocated:current.allocated,...plan,actor_id:actor.id,reason,now});log(actor,'Actualizó plan de GB',device.internal_number+' · '+source);});return send(200,{ok:true});
    }
    fail(405,'Método no permitido.');
  }
  const correctionRoute=route.match(/^usage\/([^/]+)\/corrections$/);
  if(correctionRoute){
    if(!manager)fail(403,'Solo los administradores pueden corregir consumos.');
    const entry=db.prepare('SELECT * FROM gb_usage_effective WHERE id=?').get(correctionRoute[1]);if(!entry)fail(404,'Consumo no encontrado.');const device=own(rawDevices.find(d=>d.id===entry.device_id));
    if(method==='GET')return send(200,{entry:serializeUsage({...entry,actor_name:users.find(u=>u.id===entry.actor_id)?.name}),corrections:db.prepare('SELECT c.*,a.name actor_name FROM gb_corrections c JOIN users a ON a.id=c.actor_id WHERE usage_id=? ORDER BY c.rowid').all(entry.id).map(c=>({...c,before_amount:c.before_amount/1000,after_amount:c.after_amount/1000,delta:c.delta/1000}))});
    if(method==='POST'){
      const corrected=amount(b.amount,'Consumo correcto'),reason=text(b.reason,'el motivo de la corrección',500);if(corrected===entry.effective_amount)fail(400,'La cantidad coincide con el consumo actual.');
      const plan=entry.cycle_id?db.prepare('SELECT allocated FROM gb_cycles WHERE id=?').get(entry.cycle_id):db.prepare('SELECT allocated FROM gb_legacy_plans WHERE device_id=? AND source=?').get(device.id,entry.source)||{allocated:device[entry.source+'_allocated']};
      transaction(()=>{const used=db.prepare('SELECT COALESCE(SUM(effective_amount),0) used FROM gb_usage_effective WHERE device_id=? AND source=? AND cycle_id IS ?').get(device.id,entry.source,entry.cycle_id).used;if(used-entry.effective_amount+corrected>plan.allocated)fail(400,'La corrección supera los GB asignados a ese período.');db.prepare('INSERT INTO gb_corrections VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),entry.id,corrected-entry.effective_amount,entry.effective_amount,corrected,reason,actor.id,new Date(now).toISOString());log(actor,'Corrigió consumo de GB',device.internal_number+' · '+entry.source);});return send(201,{ok:true});
    }
    fail(405,'Método no permitido.');
  }
  if(route==='dashboard'&&method==='GET'){
    const satelliteCapacity=devices.reduce((sum,d)=>sum+(d.satellite_enabled?d.capacity:0),0);
    const simCapacity=sims.reduce((sum,s)=>sum+s.capacity,0)+devices.filter(d=>d.sim_id&&!sims.some(s=>s.id===d.sim_id)).reduce((sum,d)=>sum+d.sim_capacity,0);
    const capacity=satelliteCapacity+simCapacity;
    const allocated=devices.reduce((sum,d)=>sum+d.allocated,0),used=devices.reduce((sum,d)=>sum+d.used,0);
    const usage=db.prepare(`SELECT u.*,d.kit,d.name,d.owner_id,a.name actor_name FROM gb_usage_effective u JOIN gb_devices d ON d.id=u.device_id JOIN users a ON a.id=u.actor_id ORDER BY u.date DESC,u.created_at DESC`).all().filter(u=>deviceIds.has(u.device_id));
    const channels={satellite:balance(satelliteCapacity,devices.reduce((sum,d)=>sum+d.satellite_allocated,0),devices.reduce((sum,d)=>sum+d.satellite_used,0)),sim:balance(simCapacity,devices.reduce((sum,d)=>sum+d.sim_allocated,0),devices.reduce((sum,d)=>sum+d.sim_used,0))};
    const periods=db.prepare('SELECT * FROM gb_cycles ORDER BY start_date DESC,source').all().filter(c=>deviceIds.has(c.device_id)).map(c=>({id:c.id,device_id:c.device_id,source:c.source,start_date:c.start_date,end_date:c.end_date,internal_number:devices.find(d=>d.id===c.device_id).internal_number}));
    return send(200,{periods,devices:devices.map(serializeDevice),sims:sims.map(serializeSim),owners:manager?owners.map(u=>({id:u.id,name:u.name})):[],controllers:controllers.map(u=>({id:u.id,name:u.name})),canManage:manager,canRecord:writer,channels,totals:{capacity:capacity/1000,allocated:allocated/1000,used:used/1000,remaining:(capacity-used)/1000,unallocated:(capacity-allocated)/1000,devices:devices.length,active:devices.filter(d=>d.active).length,sims:sims.length},usage:usage.slice(0,30).map(serializeUsage)});
  }
  if(route==='report'&&method==='GET'){
    const from=date(url.searchParams.get('from')),to=date(url.searchParams.get('to'));if(from>to)fail(400,'La fecha inicial debe ser anterior a la final.');
    const cycleId=url.searchParams.get('cycle')||'',cycle=cycleId&&cycleId!=='legacy'?db.prepare('SELECT * FROM gb_cycles WHERE id=?').get(cycleId):null;if(cycleId&&cycleId!=='legacy'&&(!cycle||!deviceIds.has(cycle.device_id)))fail(404,'Período no encontrado en tu alcance.');
    const deviceId=url.searchParams.get('device')||'';if(deviceId&&!devices.some(d=>d.id===deviceId))fail(404,'Equipo no encontrado.');
    const source=url.searchParams.get('source')||'';if(source&&!['satellite','sim'].includes(source))fail(400,'Tipo de conexión inválido.');
    if(cycle&&(deviceId&&deviceId!==cycle.device_id||source&&source!==cycle.source))fail(400,'El período no coincide con los filtros de equipo y conexión.');
    const selected=devices.filter(d=>(!deviceId||d.id===deviceId)&&(!cycle||d.id===cycle.device_id));
    const entries=db.prepare(`SELECT u.*,d.kit,d.name,d.owner_id,CASE WHEN u.source='sim' THEN s.number ELSE NULL END sim_number,a.name actor_name FROM gb_usage_effective u JOIN gb_devices d ON d.id=u.device_id LEFT JOIN gb_sims s ON s.id=d.sim_id JOIN users a ON a.id=u.actor_id WHERE u.date>=? AND u.date<=? ORDER BY u.date,u.created_at`).all(from,to).filter(u=>deviceIds.has(u.device_id)&&(!deviceId||u.device_id===deviceId)&&(!source||u.source===source)&&(!cycleId||(cycleId==='legacy'?!u.cycle_id:u.cycle_id===cycleId)));
    const reportAllocated=d=>cycle?cycle.allocated:['satellite','sim'].filter(ch=>!source||ch===source).reduce((sum,ch)=>sum+(cycleId==='legacy'?(db.prepare('SELECT allocated FROM gb_legacy_plans WHERE device_id=? AND source=?').get(d.id,ch)?.allocated??d[ch+'_allocated']):d[ch+'_allocated']),0);
    const rows=selected.map(d=>{const own=entries.filter(e=>e.device_id===d.id);return {id:d.id,...identity(d),allocated:reportAllocated(d)/1000,used:own.reduce((sum,e)=>sum+e.effective_amount,0)/1000,satellite_used:own.filter(e=>e.source==='satellite').reduce((sum,e)=>sum+e.effective_amount,0)/1000,sim_used:own.filter(e=>e.source==='sim').reduce((sum,e)=>sum+e.effective_amount,0)/1000,records:own.length};});
    return send(200,{from,to,source,cycle:cycleId,rows,total:entries.reduce((sum,e)=>sum+e.effective_amount,0)/1000,entries:entries.map(serializeUsage)});
  }
  if(/^devices\/[^/]+\/assignment$/.test(route)&&method==='PATCH'){
    if(!manager)fail(403,'Solo un administrador puede asignar equipos.');
    const device=own(rawDevices.find(d=>d.id===route.split('/')[1]));
    const controllerId=controller(b.controller_id);
    transaction(()=>{
      db.prepare('UPDATE gb_devices SET controller_id=? WHERE id=?').run(controllerId,device.id);
      log(actor,'Asignó un equipo a un controlador',`${device.kit} · ${controllerId?controllers.find(u=>u.id===controllerId).name:'Sin asignar'}`);
    });
    return send(200,{ok:true});
  }
  if(route==='sims'&&method==='POST'||/^sims\/[^/]+$/.test(route)&&method==='PATCH'){
    if(!manager)fail(403,'Solo un administrador puede administrar SIM cards.');
    const existing=method==='PATCH'?own(db.prepare('SELECT * FROM gb_sims WHERE id=?').get(route.split('/')[1])):null;
    const number=text(b.number,'el número de SIM',32),operator=text(b.operator??'','el operador',80,false),capacity=amount(b.capacity,'GB del plan'),ownerId=owner(b.owner_id??actor.id);
    if(db.prepare('SELECT id FROM gb_sims WHERE number=? AND id<>?').get(number,existing?.id||''))fail(409,'El número de SIM ya está registrado.');
    if(existing){const linked=rawDevices.find(d=>d.sim_id===existing.id);if(linked&&!scope.has(linked.owner_id))fail(403,'La SIM está vinculada a un equipo fuera de tu alcance.');if(linked?.periods.sim.cycle&&capacity!==existing.capacity)fail(400,'Gestioná el plan de la SIM vinculada desde Planes y ciclos.');if(linked&&capacity<linked.sim_allocated)fail(400,'El plan no puede ser menor que los GB asignados a la SIM.');if(linked&&existing.owner_id!==ownerId)fail(400,'No se puede cambiar el responsable de una SIM vinculada.');}
    transaction(()=>{if(existing)db.prepare('UPDATE gb_sims SET number=?,operator=?,capacity=?,owner_id=? WHERE id=?').run(number,operator,capacity,ownerId,existing.id);else db.prepare('INSERT INTO gb_sims VALUES (?,?,?,?,?,?)').run(randomUUID(),number,operator,capacity,ownerId,new Date().toISOString());if(existing&&capacity!==existing.capacity){const linked=rawDevices.find(d=>d.sim_id===existing.id);if(linked)gbPlanChange(db,{device_id:linked.id,source:'sim',action:'inventory',before_capacity:existing.capacity,before_allocated:linked.sim_allocated,capacity,allocated:linked.sim_allocated,actor_id:actor.id,reason:'Edición de plan desde SIM cards',now});}log(actor,existing?'Actualizó una SIM':'Registró una SIM',number);});return send(existing?200:201,{ok:true});
  }
  if(route==='devices'&&method==='POST'||/^devices\/[^/]+$/.test(route)&&method==='PATCH'){
    if(!manager)fail(403,'Solo un administrador puede administrar dispositivos.');
    const existing=method==='PATCH'?own(rawDevices.find(d=>d.id===route.split('/')[1])):null;
    const kit=text(b.kit,'el número de kit',80),name=text(b.name,'el nombre del equipo',100),simId=b.sim_id||null,ownerId=owner(b.owner_id??actor.id);
    const internalNumber=b.internal_number===undefined?(existing?.internal_number||nextInternalNumber(db)):text(b.internal_number,'el número interno',40);
    if(!/^[a-z0-9][a-z0-9._/-]{0,39}$/i.test(internalNumber))fail(400,'El número interno admite hasta 40 letras, números, puntos, guiones, barras y guiones bajos.');
    if(db.prepare('SELECT id FROM gb_devices WHERE internal_number=? COLLATE NOCASE AND id<>?').get(internalNumber,existing?.id||''))fail(409,'Ese número interno ya existe.');
    const requestedController=b.controller_id===undefined?(existing?existing.controller_id:(controllers.some(u=>u.id===ownerId)?ownerId:null)):b.controller_id||null;
    const controllerId=existing&&requestedController===existing.controller_id?requestedController:controller(requestedController);
    const satelliteEnabled=b.satellite_enabled??!simId;
    if(typeof satelliteEnabled!=='boolean')fail(400,'Indicá si el equipo tiene servicio satelital.');
    const capacity=amount(b.capacity??0,'GB del plan satelital');
    const satelliteAllocated=amount(b.satellite_allocated??(!simId?b.allocated:0),'GB asignados satelitales');
    const simAllocated=amount(b.sim_allocated??(simId?b.allocated:0),'GB asignados SIM');
    const allocated=satelliteAllocated+simAllocated;
    if(existing){const stored=db.prepare('SELECT * FROM gb_devices WHERE id=?').get(existing.id);if(existing.periods.satellite.cycle&&(capacity!==stored.capacity||satelliteAllocated!==stored.satellite_allocated||!satelliteEnabled))fail(400,'Gestioná el plan satelital desde Planes y ciclos.');if(existing.periods.sim.cycle&&simAllocated!==stored.sim_allocated)fail(400,'Gestioná el plan SIM desde Planes y ciclos.');}
    if(simId!==null&&(typeof simId!=='string'||simId.length>80))fail(400,'Seleccioná una SIM válida.');
    if(typeof b.active!=='boolean')fail(400,'Indicá el estado del equipo.');
    if(db.prepare('SELECT id FROM gb_devices WHERE kit=? AND id<>?').get(kit,existing?.id||''))fail(409,'Ese número de kit ya existe.');
    if(!satelliteEnabled&&!simId)fail(400,'Habilitá un servicio satelital, una SIM o ambos.');
    if(!satelliteEnabled&&satelliteAllocated>0)fail(400,'No se pueden asignar GB satelitales sin habilitar ese servicio.');
    let maxSim=0;if(simId){const sim=db.prepare('SELECT * FROM gb_sims WHERE id=?').get(simId);if(!sim||(!scope.has(sim.owner_id)&&existing?.sim_id!==simId))fail(404,'SIM no encontrada en tu alcance.');maxSim=sim.capacity;if(rawDevices.some(d=>d.sim_id===simId&&d.id!==existing?.id))fail(409,'Esta SIM ya está vinculada a otro equipo.');}
    if(!simId&&simAllocated>0)fail(400,'Seleccioná una SIM para asignar GB móviles.');
    if(satelliteAllocated>(satelliteEnabled?capacity:0)||simAllocated>maxSim)fail(400,'Los GB asignados no pueden superar el plan de cada conexión.');
    if(existing&&(satelliteAllocated<existing.satellite_used||simAllocated<existing.sim_used))fail(400,'La asignación de cada conexión no puede ser menor que su consumo registrado.');
    if(existing&&simId!==existing.sim_id&&(db.prepare("SELECT 1 FROM gb_usage WHERE device_id=? AND source='sim' LIMIT 1").get(existing.id)||db.prepare("SELECT 1 FROM gb_cycles WHERE device_id=? AND source='sim' LIMIT 1").get(existing.id)))fail(400,'La SIM tiene consumos. Conservá su vínculo para mantener el historial.');
    const deviceId=existing?.id||randomUUID();
    transaction(()=>{if(simId)db.prepare('UPDATE gb_sims SET owner_id=? WHERE id=?').run(ownerId,simId);if(existing)db.prepare('UPDATE gb_devices SET kit=?,name=?,sim_id=?,capacity=?,allocated=?,owner_id=?,active=?,satellite_enabled=?,satellite_allocated=?,sim_allocated=?,controller_id=?,internal_number=? WHERE id=?').run(kit,name,simId,capacity,allocated,ownerId,Number(b.active),Number(satelliteEnabled),satelliteAllocated,simAllocated,controllerId,internalNumber,existing.id);else db.prepare('INSERT INTO gb_devices (id,kit,name,sim_id,capacity,allocated,owner_id,active,created_at,satellite_enabled,satellite_allocated,sim_allocated,controller_id,internal_number) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(deviceId,kit,name,simId,capacity,allocated,ownerId,Number(b.active),new Date().toISOString(),Number(satelliteEnabled),satelliteAllocated,simAllocated,controllerId,internalNumber);for(const [source,enabled,planCapacity,planAllocated] of [['satellite',satelliteEnabled,capacity,satelliteAllocated],['sim',!!simId,maxSim,simAllocated]]){const before=existing?.periods[source];if(enabled&&(!before||!before.cycle&&(before.capacity!==planCapacity||before.allocated!==planAllocated)))gbPlanChange(db,{device_id:deviceId,source,action:existing?'inventory':'initial',before_capacity:before?.capacity??null,before_allocated:before?.allocated??null,capacity:planCapacity,allocated:planAllocated,actor_id:actor.id,reason:'Plan registrado desde inventario',now});}log(actor,existing?'Actualizó un dispositivo':'Registró un dispositivo',kit);});return send(existing?200:201,{ok:true});
  }
  if(route==='usage'&&method==='POST'){
    if(!writer)fail(403,'Tu cuenta tiene acceso de lectura.');
    const device=own(rawDevices.find(d=>d.id===b.device_id));if(!device.active)fail(400,'El equipo está inactivo.');
    const source=b.source??(device.sim_id&&!device.satellite_enabled?'sim':device.satellite_enabled&&!device.sim_id?'satellite':null);
    if(!['satellite','sim'].includes(source))fail(400,'Seleccioná si el consumo es satelital o de la SIM.');
    if(source==='sim'&&!device.sim_id||source==='satellite'&&!device.satellite_enabled)fail(400,'Ese tipo de conexión no está habilitado en el equipo.');
    const value=amount(b.amount,'Consumo en GB',true),day=date(b.date),note=text(b.note??'','la observación',500,false);
    const today=gbToday(now);
    if(day>today)fail(400,'No se pueden registrar consumos futuros.');
    const cycle=db.prepare('SELECT * FROM gb_cycles WHERE device_id=? AND source=? AND start_date<=? AND end_date>?').get(device.id,source,day,day);const monthly=db.prepare('SELECT 1 FROM gb_cycle_settings WHERE device_id=? AND source=?').get(device.id,source);if(monthly&&!cycle)fail(400,'No hay un período abierto para esa fecha. Renovalo o elegí una fecha de un período existente.');
    transaction(()=>{const current=db.prepare('SELECT COALESCE(SUM(effective_amount),0) used FROM gb_usage_effective WHERE device_id=? AND source=? AND cycle_id IS ?').get(device.id,source,cycle?.id||null).used;const limit=cycle?cycle.allocated:device[source+'_allocated'];if(current+value>limit)fail(400,'El consumo supera los GB asignados a esa conexión y período.');db.prepare('INSERT INTO gb_usage (id,device_id,amount,date,note,actor_id,created_at,source,cycle_id) VALUES (?,?,?,?,?,?,?,?,?)').run(randomUUID(),device.id,value,day,note,actor.id,new Date(now).toISOString(),source,cycle?.id||null);log(actor,'Registró consumo de GB',`${device.internal_number} · ${source==='sim'?'SIM':'Satelital'}: ${value/1000} GB`);});return send(201,{ok:true});
  }
  fail(404,'Operación de Gestión de GB no encontrada.');
}
