import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {initializeGb,handleGb,GB_APP} from '../gb.mjs';
import {nextGbMonth,gbToday,renewGbCycles} from '../gb-periods.mjs';
import {initializeTracking} from '../tracking.mjs';
import {initializeAlerts,evaluateAlerts} from '../alerts.mjs';
function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('PRAGMA foreign_keys=ON;CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,role TEXT);CREATE TABLE apps(id TEXT PRIMARY KEY,name TEXT,description TEXT,url TEXT,color TEXT);');
  const users=[['root','superadmin'],['admin','admin'],['controller','controlador'],['reader','usuario'],['other','controlador']].map(([id,role])=>({id,name:id,role,active:true,apps:[GB_APP]}));for(const u of users)db.prepare('INSERT INTO users VALUES (?,?,?)').run(u.id,u.name,u.role);
  initializeGb(db);let now=Date.parse('2026-10-31T12:00:00Z');
  const call=(who,route,method='GET',b={})=>handleGb({db,actor:users.find(u=>u.id===who),users,now,url:new URL('http://localhost/api/gb/'+route),method,b,send:(status,data)=>({status,data}),fail(status,message){throw Object.assign(Error(message),{status});},log(){},transaction(fn){db.exec('BEGIN');try{fn();db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}});
  call('root','sims','POST',{number:'SIM-PRIVADA',capacity:100});const sim=call('root','dashboard').data.sims[0];
  const body={kit:'KIT-PRIVADO',name:'Nombre privado',internal_number:'00008',owner_id:'reader',controller_id:'controller',satellite_enabled:true,capacity:200,satellite_allocated:100,sim_id:sim.id,sim_allocated:50,active:true};call('root','devices','POST',body);const device=call('root','dashboard').data.devices[0];
  const usage=(source,amount,date=gbToday(now),who='root')=>call(who,'usage','POST',{device_id:device.id,source,amount,date,note:'Nota privada'});
  const start=(source,auto_renew=false,anchor_day=31)=>call('root',`devices/${device.id}/cycles/${source}/start`,'POST',{capacity:200,allocated:100,start_date:gbToday(now),anchor_day,auto_renew});
  return {db,call,device,body,usage,start,at(date){now=Date.parse(date+'T12:00:00Z');},now:()=>now};
}

test('GB mensual: calendario anclado, legado intacto, renovaciones idempotentes y SIM independiente',t=>{
  const f=fixture(t),{call,db,device}=f;
  assert.equal(nextGbMonth('2026-01-31',31),'2026-02-28');assert.equal(nextGbMonth('2026-02-28',31),'2026-03-31');assert.equal(nextGbMonth('2028-01-31',31),'2028-02-29');
  f.usage('satellite',80);f.usage('sim',25);f.start('satellite',true);
  let panel=call('root','dashboard').data,d=panel.devices[0];assert.equal(d.satellite.used,0);assert.equal(d.sim.used,25);assert.equal(d.satellite.cycle.end_date,'2026-11-30');assert.equal(panel.totals.used,25);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM gb_usage WHERE cycle_id IS NULL').get().n,2);
  assert.throws(()=>f.start('satellite'),e=>e.status===409);
  f.usage('satellite',80);const first=d.satellite.cycle.id;
  f.at('2026-11-30');panel=call('root','dashboard').data;d=panel.devices[0];assert.equal(d.satellite.cycle.start_date,'2026-11-30');assert.equal(d.satellite.cycle.end_date,'2026-12-31');assert.equal(d.satellite.used,0);assert.equal(d.sim.used,25);
  call('root','dashboard');assert.equal(db.prepare('SELECT COUNT(*) n FROM gb_cycles').get().n,2);
  f.at('2027-02-28');renewGbCycles(db,f.now());assert.equal(db.prepare('SELECT COUNT(*) n FROM gb_cycles').get().n,5);assert.equal(call('root','dashboard').data.devices[0].satellite.cycle.end_date,'2027-03-31');
  const report=call('root','report?from=2026-10-01&to=2026-11-29&cycle='+first).data;assert.equal(report.total,80);assert.equal(report.entries.length,1);
  const legacy=call('root','report?from=2026-10-01&to=2026-11-29&cycle=legacy').data;assert.equal(legacy.total,105);
  const history=call('controller',`devices/${device.id}/cycles`).data;assert.equal(history.cycles.length,5);assert.equal(history.cycles.find(c=>c.id===first).used,80);assert.deepEqual(history.changes,[]);assert.ok(!JSON.stringify(history).includes('KIT-PRIVADO'));assert.ok(!JSON.stringify(history).includes('Nombre privado'));assert.ok(!JSON.stringify(history).includes('SIM-PRIVADA'));
  assert.throws(()=>call('other',`devices/${device.id}/cycles`),e=>e.status===404);
  assert.throws(()=>call('other','report?from=2026-10-01&to=2026-11-29&cycle='+first),e=>e.status===404);
  initializeGb(db);assert.equal(db.prepare('SELECT COUNT(*) n FROM gb_cycles').get().n,5);
});

test('GB: período vencido, renovación manual, plantilla futura y edición auditada del plan vigente',t=>{
  const f=fixture(t),{call,device,body}=f;f.start('satellite');f.usage('satellite',80);
  const planPath=`devices/${device.id}/cycles/satellite/plan`,settingsPath=`devices/${device.id}/cycles/satellite/settings`;
  assert.throws(()=>call('root',planPath,'PATCH',{capacity:100,allocated:79,reason:'Bajar asignación'}),e=>e.status===400);
  call('root',planPath,'PATCH',{capacity:300,allocated:200,reason:'Ampliación por operación'});assert.equal(call('root','dashboard').data.devices[0].satellite.allocated,200);
  call('root',settingsPath,'PATCH',{capacity:400,allocated:250,auto_renew:false,reason:'Plan del mes siguiente'});assert.equal(call('root','dashboard').data.devices[0].satellite.allocated,200);
  assert.throws(()=>call('controller',settingsPath,'PATCH',{capacity:400,allocated:250,auto_renew:true,reason:'No permitido'}),e=>e.status===403);
  assert.throws(()=>call('root','devices/'+device.id,'PATCH',{...body,capacity:301,satellite_allocated:200}),e=>e.status===400);
  assert.throws(()=>call('root',`devices/${device.id}/cycles/satellite/renew`,'POST',{}),e=>e.status===400);
  f.at('2026-11-30');let d=call('root','dashboard').data.devices[0];assert.equal(d.satellite.mode,'expired');assert.equal(d.satellite.used,0);assert.equal(d.satellite.capacity,0);
  assert.throws(()=>f.usage('satellite',1),e=>e.status===400);
  call('root',`devices/${device.id}/cycles/satellite/renew`,'POST',{});d=call('root','dashboard').data.devices[0];assert.equal(d.satellite.allocated,250);assert.equal(d.satellite.capacity,400);f.usage('satellite',10);
  f.usage('satellite',20,'2026-11-01');assert.equal(call('root','dashboard').data.devices[0].satellite.used,10);
  const changes=call('root',`devices/${device.id}/cycles`).data.changes;assert.ok(changes.some(c=>c.reason==='Ampliación por operación'&&c.actor_name==='root'&&c.before_allocated===100&&c.allocated===200));assert.ok(changes.some(c=>c.action==='template'));
  assert.equal(call('root','report?from=2026-10-01&to=2026-11-30&cycle=legacy&source=satellite').data.rows[0].allocated,100);
});

test('GB: correcciones inmutables, saldo por período, reportes efectivos y motivos reservados',t=>{
  const f=fixture(t),{call,db,device}=f;f.usage('satellite',80);const legacy=call('root','dashboard').data.usage.find(u=>u.source==='satellite');f.start('satellite');f.usage('satellite',90);const row=call('root','dashboard').data.usage.find(u=>u.cycle_id);
  call('admin',`usage/${row.id}/corrections`,'POST',{amount:70,reason:'Lectura duplicada KIT-PRIVADO'});assert.equal(db.prepare('SELECT amount FROM gb_usage WHERE id=?').get(row.id).amount,90000);assert.equal(call('root','dashboard').data.devices[0].satellite.used,70);
  call('admin',`usage/${row.id}/corrections`,'POST',{amount:0,reason:'Anulación por error'});assert.equal(call('root','dashboard').data.devices[0].satellite.used,0);
  const details=call('root',`usage/${row.id}/corrections`).data;assert.equal(details.corrections.length,2);assert.equal(details.corrections[0].before_amount,90);assert.equal(details.corrections[1].before_amount,70);assert.equal(details.corrections[1].after_amount,0);assert.equal(details.corrections[1].actor_name,'admin');
  assert.throws(()=>call('controller',`usage/${row.id}/corrections`,'POST',{amount:0,reason:'No'}),e=>e.status===403);assert.throws(()=>call('reader',`usage/${row.id}/corrections`),e=>e.status===403);
  assert.throws(()=>call('root',`usage/${row.id}/corrections`,'POST',{amount:101,reason:'Exceso'}),e=>e.status===400);
  assert.throws(()=>call('root',`usage/${row.id}/corrections`,'POST',{amount:10,reason:''}),e=>e.status===400);
  call('root',`usage/${legacy.id}/corrections`,'POST',{amount:60,reason:'Ajuste del acumulado anterior'});assert.equal(call('root','dashboard').data.devices[0].satellite.used,0);
  const report=call('controller','report?from=2026-10-01&to=2026-11-01').data;assert.equal(report.total,60);assert.equal(report.entries.find(e=>e.id===row.id).corrected,true);assert.equal(report.entries.find(e=>e.id===row.id).original_amount,90);assert.ok(!JSON.stringify(report).includes('KIT-PRIVADO'));
  f.at('2026-11-30');call('root',`devices/${device.id}/cycles/satellite/renew`,'POST',{});f.usage('satellite',50);call('root',`usage/${row.id}/corrections`,'POST',{amount:20,reason:'Corrección histórica'});assert.equal(call('root','dashboard').data.devices[0].satellite.used,50);
});

test('GB: alertas usan consumos corregidos y no arrastran umbrales entre períodos',t=>{
  const f=fixture(t);initializeTracking(f.db);initializeAlerts(f.db);f.start('satellite',true);f.usage('satellite',85);evaluateAlerts(f.db,f.now());
  let events=f.db.prepare("SELECT * FROM alert_events WHERE type='gb'").all();assert.equal(events.length,1);const row=f.call('root','dashboard').data.usage.find(u=>u.cycle_id);
  f.call('root',`usage/${row.id}/corrections`,'POST',{amount:60,reason:'Corrección de lectura'});evaluateAlerts(f.db,f.now());assert.equal(f.db.prepare('SELECT condition_active FROM alert_events WHERE id=?').get(events[0].id).condition_active,0);
  f.usage('satellite',25);evaluateAlerts(f.db,f.now());assert.equal(f.db.prepare('SELECT COUNT(*) n FROM alert_events').get().n,2);
  f.at('2026-11-30');evaluateAlerts(f.db,f.now());assert.equal(f.db.prepare('SELECT COUNT(*) n FROM alert_events WHERE condition_active=1').get().n,0);f.usage('satellite',85);evaluateAlerts(f.db,f.now());assert.equal(f.db.prepare('SELECT COUNT(*) n FROM alert_events').get().n,3);
});
