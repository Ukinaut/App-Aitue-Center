import {randomUUID} from 'node:crypto';
import {renewGbCycles,gbChannel} from './gb-periods.mjs';
const GB='aitue-gestion-gb',TRK='aitue-trackeo-video';
const manager=a=>['superadmin','admin'].includes(a.role);
const has=(a,app)=>a.role==='superadmin'||a.apps.includes(app);
const types={gb:'Consumo de GB',stale:'Falta de posiciones GPS',speed:'Exceso de velocidad',enter:'Entrada a zona',exit:'Salida de zona'};
export function initializeAlerts(db){
  db.exec(`CREATE TABLE IF NOT EXISTS alert_settings(id INTEGER PRIMARY KEY CHECK(id=1),gb_percent REAL NOT NULL);INSERT OR IGNORE INTO alert_settings VALUES(1,80);
    CREATE TABLE IF NOT EXISTS alert_tracking_rules(unit_id TEXT PRIMARY KEY REFERENCES tracking_units(id),stale_minutes INTEGER,speed_limit REAL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,speed_at TEXT,speed_id INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS alert_zones(id TEXT PRIMARY KEY,unit_id TEXT NOT NULL REFERENCES tracking_units(id),name TEXT NOT NULL,lat REAL NOT NULL,lon REAL NOT NULL,radius REAL NOT NULL,on_enter INTEGER NOT NULL,on_exit INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,cursor_at TEXT,cursor_id INTEGER NOT NULL DEFAULT 0,inside INTEGER);
    CREATE TABLE IF NOT EXISTS alert_events(id TEXT PRIMARY KEY,source TEXT NOT NULL,entity_id TEXT NOT NULL,type TEXT NOT NULL,severity TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',condition_active INTEGER NOT NULL DEFAULT 1,details TEXT NOT NULL,occurred_at TEXT NOT NULL,created_at TEXT NOT NULL,last_seen TEXT NOT NULL,recovered_at TEXT);
    CREATE INDEX IF NOT EXISTS alert_events_scope ON alert_events(source,entity_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS alert_events_time ON alert_events(created_at DESC,id);
    CREATE TABLE IF NOT EXISTS alert_conditions(key TEXT PRIMARY KEY,active INTEGER NOT NULL,event_id TEXT REFERENCES alert_events(id));
    CREATE TABLE IF NOT EXISTS alert_actions(id INTEGER PRIMARY KEY,event_id TEXT NOT NULL REFERENCES alert_events(id),actor_id TEXT NOT NULL REFERENCES users(id),action TEXT NOT NULL,created_at TEXT NOT NULL);`);
}
export function inAlertZone(lat,lon,zone){
  const r=Math.PI/180,a=Math.sin((lat-zone.lat)*r/2)**2+Math.cos(lat*r)*Math.cos(zone.lat*r)*Math.sin((lon-zone.lon)*r/2)**2;
  return 6371*2*Math.asin(Math.min(1,Math.sqrt(a)))<=zone.radius;
}
export function evaluateAlerts(db,now=Date.now()){
  renewGbCycles(db,now);
  const stamp=new Date(now).toISOString(),touched=new Set();
  const create=(source,entity,type,severity,details,occurred=stamp,active=1)=>{
    const id=randomUUID();db.prepare('INSERT INTO alert_events(id,source,entity_id,type,severity,condition_active,details,occurred_at,created_at,last_seen,recovered_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,source,entity,type,severity,active,JSON.stringify(details),occurred,stamp,stamp,active?null:stamp);return id;
  };
  const condition=(key,active,source,entity,type,severity,details,occurred=stamp)=>{
    touched.add(key);const prior=db.prepare('SELECT * FROM alert_conditions WHERE key=?').get(key);
    if(active){if(!prior?.active){const id=create(source,entity,type,severity,details,occurred);db.prepare('INSERT INTO alert_conditions VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET active=1,event_id=excluded.event_id').run(key,id);}else db.prepare('UPDATE alert_events SET severity=?,details=?,last_seen=? WHERE id=?').run(severity,JSON.stringify(details),stamp,prior.event_id);}
    else if(prior?.active){db.prepare('UPDATE alert_conditions SET active=0 WHERE key=?').run(key);db.prepare('UPDATE alert_events SET condition_active=0,recovered_at=? WHERE id=?').run(stamp,prior.event_id);}
  };
  db.exec('BEGIN IMMEDIATE');
  try{
    const threshold=db.prepare('SELECT gb_percent FROM alert_settings WHERE id=1').get().gb_percent;
    const gb=db.prepare(`SELECT d.*,COALESCE((SELECT SUM(amount) FROM gb_usage WHERE device_id=d.id AND source='satellite'),0) sat_used,COALESCE((SELECT SUM(amount) FROM gb_usage WHERE device_id=d.id AND source='sim'),0) sim_used FROM gb_devices d WHERE active=1`).all();
    for(const d of gb)for(const channel of ['satellite','sim']){
      const plan=gbChannel(db,d,channel,now),enabled=channel==='satellite'?d.satellite_enabled:d.sim_id,{allocated,used}=plan;
      const percent=allocated?used/allocated*100:0;
      condition(`gb:${d.id}:${channel}${plan.cycle?':'+plan.cycle.id:''}`,!!enabled&&allocated>0&&percent>=threshold,'gb',d.id,'gb',percent>=100?'critical':'warning',{channel,used:used/1000,allocated:allocated/1000,percent:Math.round(percent*100)/100,threshold,period:plan.cycle?plan.cycle.start_date+' → '+plan.cycle.end_date:'Acumulado anterior'});
    }
    const units=db.prepare('SELECT * FROM tracking_units WHERE active=1').all();
    for(const u of units){
      const devices=db.prepare('SELECT id,created_at FROM tracking_devices WHERE unit_id=?').all(u.id);if(!devices.length)continue;
      db.prepare('INSERT OR IGNORE INTO alert_tracking_rules(unit_id,stale_minutes,created_at,updated_at) VALUES (?,30,?,?)').run(u.id,stamp,stamp);
      const rule=db.prepare('SELECT * FROM alert_tracking_rules WHERE unit_id=?').get(u.id);
      const latest=db.prepare(`SELECT p.* FROM tracking_positions p JOIN tracking_devices d ON d.id=p.device_id AND d.unit_id=p.unit_id WHERE p.unit_id=? AND p.source IN ('rinho','wialon') AND p.recorded_at<=? ORDER BY p.recorded_at DESC,p.id DESC LIMIT 1`).get(u.id,stamp);
      const reference=latest?.recorded_at||devices.map(d=>d.created_at).sort().at(-1),age=Math.max(0,(now-Date.parse(reference))/60000);
      if(rule.stale_minutes!==null)condition('stale:'+u.id,Number.isFinite(age)&&age>=rule.stale_minutes,'tracking',u.id,'stale','warning',{minutes:Math.floor(age),threshold:rule.stale_minutes,last_sample:latest?.recorded_at||null,reference,source:latest?.source||null});
      const samples=(cursorAt,cursorId,from)=>db.prepare(`SELECT p.* FROM tracking_positions p JOIN tracking_devices d ON d.id=p.device_id AND d.unit_id=p.unit_id WHERE p.unit_id=? AND p.source IN ('rinho','wialon') AND p.recorded_at>=? AND p.recorded_at<=? AND (p.recorded_at>? OR (p.recorded_at=? AND p.id>?)) ORDER BY p.recorded_at,p.id LIMIT 1000`).all(u.id,from,stamp,cursorAt||'',cursorAt||'',cursorId);
      if(rule.speed_limit!==null){
        touched.add('speed:'+u.id);
        const rows=samples(rule.speed_at,rule.speed_id,rule.created_at);
        for(const p of rows){if(p.speed!==null)condition('speed:'+u.id,p.speed>rule.speed_limit,'tracking',u.id,'speed','critical',{speed:p.speed,limit:rule.speed_limit,source:p.source,sample_at:p.recorded_at},p.recorded_at);}
        if(rows.length){const p=rows.at(-1);db.prepare('UPDATE alert_tracking_rules SET speed_at=?,speed_id=? WHERE unit_id=?').run(p.recorded_at,p.id,u.id);}
        if(rows.length<1000&&latest&&now-Date.parse(latest.recorded_at)>Math.max(30,rule.stale_minutes||30)*60000)condition('speed:'+u.id,false);
      }
      for(const zone of db.prepare('SELECT * FROM alert_zones WHERE unit_id=? AND active=1').all(u.id)){
        const rows=samples(zone.cursor_at,zone.cursor_id,zone.created_at);let inside=zone.inside;
        for(const p of rows){const current=Number(inAlertZone(p.lat,p.lon,zone));if(inside!==null&&current!==inside&&((current&&zone.on_enter)||(!current&&zone.on_exit)))create('tracking',u.id,current?'enter':'exit','info',{zone_id:zone.id,source:p.source,sample_at:p.recorded_at,radius:zone.radius},p.recorded_at,0);inside=current;}
        if(rows.length){const p=rows.at(-1);db.prepare('UPDATE alert_zones SET cursor_at=?,cursor_id=?,inside=? WHERE id=?').run(p.recorded_at,p.id,inside,zone.id);}
      }
    }
    for(const c of db.prepare('SELECT key FROM alert_conditions WHERE active=1').all())if(!touched.has(c.key))condition(c.key,false);
    db.exec('COMMIT');return {evaluated_at:stamp};
  }catch(error){db.exec('ROLLBACK');throw error;}
}
export function handleAlerts({db,actor,url,method,b,send,fail,transaction,log,now=Date.now()}){
  const route=url.pathname.slice('/api/alerts/'.length),isManager=manager(actor),canGb=has(actor,GB),canTrk=has(actor,TRK),canOperate=isManager||actor.role==='controlador';
  if(!canGb&&!canTrk)fail(403,'Necesitás acceso a Gestión de GB o Trackeo para consultar alertas.');
  const gb=db.prepare('SELECT id,internal_number,kit,name,owner_id,controller_id FROM gb_devices').all().filter(d=>canGb&&(isManager||(actor.role==='controlador'?d.controller_id===actor.id:d.owner_id===actor.id)));
  const trk=db.prepare('SELECT id,internal_number,name,identifier,active FROM tracking_units').all().filter(u=>canTrk&&(isManager||db.prepare('SELECT 1 FROM tracking_unit_access WHERE unit_id=? AND user_id=?').get(u.id,actor.id)));
  const visible=e=>(e.source==='gb'?gb:trk).some(d=>d.id===e.entity_id);
  const serialize=e=>{
    const entity=(e.source==='gb'?gb:trk).find(d=>d.id===e.entity_id),details=JSON.parse(e.details);
    return {...e,details,type_label:types[e.type],internal_number:entity.internal_number,entity_name:isManager?entity.name:entity.internal_number,real_identifier:isManager?(entity.kit||entity.identifier):null,zone_name:details.zone_id?(isManager?db.prepare('SELECT name FROM alert_zones WHERE id=?').get(details.zone_id)?.name:'Zona '+details.zone_id.slice(0,8)):null};
  };
  if(route==='dashboard'&&method==='GET'){
    evaluateAlerts(db,now);
    const options={status:['pending','open','ack','closed','all'],source:['gb','tracking'],type:Object.keys(types),severity:['info','warning','critical']};
    for(const [key,values] of Object.entries(options)){const value=url.searchParams.get(key);if(value&&!values.includes(value))fail(400,'Filtro inválido: '+key);}
    const page=Number(url.searchParams.get('page')||1);if(!Number.isInteger(page)||page<1||page>100000)fail(400,'Página inválida.');
    const q=(url.searchParams.get('q')||'').trim().toLowerCase();if(q.length>100)fail(400,'La búsqueda es demasiado larga.');
    const all=db.prepare('SELECT * FROM alert_events ORDER BY created_at DESC,id DESC').all().filter(visible).map(serialize);
    const status=url.searchParams.get('status')||'pending';
    const rows=all.filter(e=>(status==='all'||status==='pending'&&e.status!=='closed'||e.status===status)&&['source','type','severity'].every(k=>!url.searchParams.get(k)||e[k]===url.searchParams.get(k))&&(!q||[e.internal_number,e.entity_name,e.real_identifier,e.type_label,e.zone_name].filter(Boolean).some(v=>v.toLowerCase().includes(q))));
    return send(200,{items:rows.slice((page-1)*25,page*25),total:rows.length,page,summary:{open:all.filter(e=>e.status==='open').length,ack:all.filter(e=>e.status==='ack').length,critical:all.filter(e=>e.status!=='closed'&&e.severity==='critical').length,closed:all.filter(e=>e.status==='closed').length},canOperate,canManage:isManager,canGb,canTrk,evaluated_at:new Date(now).toISOString()});
  }
  if(route==='configuration'&&method==='GET'){
    if(!isManager)fail(403,'Solo los administradores configuran reglas.');
    return send(200,{gb_percent:canGb?db.prepare('SELECT gb_percent FROM alert_settings WHERE id=1').get().gb_percent:null,units:trk.map(u=>({...u,...(db.prepare('SELECT stale_minutes,speed_limit FROM alert_tracking_rules WHERE unit_id=?').get(u.id)||{stale_minutes:30,speed_limit:null})})),zones:canTrk?db.prepare('SELECT * FROM alert_zones ORDER BY created_at DESC').all():[]});
  }
  const action=route.match(/^events\/([a-z0-9-]+)(?:\/(status))?$/i);
  if(action){
    const event=db.prepare('SELECT * FROM alert_events WHERE id=?').get(action[1]);if(!event||!visible(event))fail(404,'Alerta no encontrada en tu alcance.');
    if(!action[2]&&method==='GET')return send(200,{event:serialize(event),actions:db.prepare('SELECT a.action,a.created_at,u.name actor_name FROM alert_actions a JOIN users u ON u.id=a.actor_id WHERE a.event_id=? ORDER BY a.id').all(event.id)});
    if(action[2]&&method==='PATCH'){
      if(!canOperate)fail(403,'Tu cuenta tiene acceso de lectura.');
      if(!['open','ack','closed'].includes(b.status))fail(400,'Estado inválido.');
      if(event.status===b.status)return send(200,{ok:true});
      transaction(()=>{db.prepare('UPDATE alert_events SET status=? WHERE id=?').run(b.status,event.id);db.prepare('INSERT INTO alert_actions(event_id,actor_id,action,created_at) VALUES (?,?,?,?)').run(event.id,actor.id,b.status,new Date(now).toISOString());log(actor,'Actualizó estado de alerta',`${event.source} · ${event.type} · ${b.status}`);});return send(200,{ok:true});
    }
    fail(405,'Método no permitido.');
  }
  if(!isManager)fail(403,'Solo los administradores configuran reglas.');
  const number=(key,min,max,nullable=false)=>{const v=b[key];if(nullable&&v===null)return null;if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)fail(400,'Revisá '+key+'.');return v;};
  if(route==='settings'&&method==='PATCH'){
    if(!canGb)fail(403,'No tenés acceso a Gestión de GB.');const value=number('gb_percent',1,100);
    transaction(()=>{db.prepare('UPDATE alert_settings SET gb_percent=? WHERE id=1').run(value);log(actor,'Configuró alertas de GB',String(value)+'%');});return send(200,{ok:true});
  }
  const rule=route.match(/^units\/([a-z0-9-]+)\/rule$/i);
  if(rule&&method==='PATCH'){
    if(!canTrk||!trk.some(u=>u.id===rule[1]))fail(404,'Unidad no encontrada en tu alcance.');
    const stale=number('stale_minutes',1,10080,true),speed=number('speed_limit',1,2000,true);if(stale!==null&&!Number.isInteger(stale))fail(400,'El intervalo se expresa en minutos enteros.');
    const stamp=new Date(now).toISOString();transaction(()=>{db.prepare(`INSERT INTO alert_tracking_rules(unit_id,stale_minutes,speed_limit,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(unit_id) DO UPDATE SET stale_minutes=excluded.stale_minutes,speed_limit=excluded.speed_limit,created_at=excluded.created_at,updated_at=excluded.updated_at,speed_at=NULL,speed_id=0`).run(rule[1],stale,speed,stamp,stamp);
      const condition=db.prepare('SELECT event_id FROM alert_conditions WHERE key=? AND active=1').get('speed:'+rule[1]);if(condition){db.prepare('UPDATE alert_events SET condition_active=0,recovered_at=? WHERE id=?').run(stamp,condition.event_id);db.prepare('UPDATE alert_conditions SET active=0 WHERE key=?').run('speed:'+rule[1]);}
      log(actor,'Configuró reglas de Trackeo',rule[1]);});return send(200,{ok:true});
  }
  const zone=route.match(/^zones(?:\/([a-z0-9-]+))?$/i);
  if(zone&&['POST','PATCH'].includes(method)&&!!zone[1]===(method==='PATCH')){
    if(!canTrk)fail(403,'No tenés acceso a Trackeo.');
    const old=zone[1]?db.prepare('SELECT * FROM alert_zones WHERE id=?').get(zone[1]):null;if(zone[1]&&!old)fail(404,'Zona no encontrada.');
    if(!trk.some(u=>u.id===b.unit_id&&(u.active||old?.unit_id===u.id&&b.active===false)))fail(400,'Seleccioná una unidad habilitada.');
    if(typeof b.name!=='string'||!b.name.trim()||b.name.length>80)fail(400,'Ingresá un nombre de zona de hasta 80 caracteres.');
    const lat=number('lat',-90,90),lon=number('lon',-180,180),radius=number('radius',0.05,1000);
    if(typeof b.on_enter!=='boolean'||typeof b.on_exit!=='boolean'||!b.on_enter&&!b.on_exit||typeof b.active!=='boolean')fail(400,'Seleccioná los eventos y el estado de la zona.');
    const id=old?.id||randomUUID();transaction(()=>{if(old)db.prepare('UPDATE alert_zones SET unit_id=?,name=?,lat=?,lon=?,radius=?,on_enter=?,on_exit=?,active=?,created_at=?,cursor_at=NULL,cursor_id=0,inside=NULL WHERE id=?').run(b.unit_id,b.name.trim(),lat,lon,radius,Number(b.on_enter),Number(b.on_exit),Number(b.active),new Date(now).toISOString(),id);else db.prepare('INSERT INTO alert_zones(id,unit_id,name,lat,lon,radius,on_enter,on_exit,active,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,b.unit_id,b.name.trim(),lat,lon,radius,Number(b.on_enter),Number(b.on_exit),Number(b.active),new Date(now).toISOString());log(actor,old?'Editó zona de alertas':'Creó zona de alertas',id);});return send(old?200:201,{id});
  }
  fail(404,'Operación de alertas no encontrada.');
}
