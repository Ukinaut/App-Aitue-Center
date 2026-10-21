import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {initializeGb} from '../gb.mjs';
import {initializeTracking} from '../tracking.mjs';
import {initializeAlerts,evaluateAlerts,handleAlerts,inAlertZone} from '../alerts.mjs';
const GB='aitue-gestion-gb',TRK='aitue-trackeo-video',base=Date.parse('2026-10-21T12:00:00.000Z'),stamp=t=>new Date(t).toISOString();
function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec("PRAGMA foreign_keys=ON;CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,role TEXT,active INTEGER);CREATE TABLE apps(id TEXT PRIMARY KEY,name TEXT,description TEXT,url TEXT,color TEXT);");
  for(const [id,role] of [['root','superadmin'],['admin','admin'],['controller','controlador'],['other','controlador'],['viewer','usuario']])db.prepare('INSERT INTO users VALUES (?,?,?,1)').run(id,id,role);
  initializeGb(db);initializeTracking(db);initializeAlerts(db);initializeAlerts(db);
  let time=base;
  const call=(id,route,method='GET',b={},apps=[GB,TRK])=>handleAlerts({db,actor:{id,role:db.prepare('SELECT role FROM users WHERE id=?').get(id).role,apps},url:new URL('http://localhost/api/alerts/'+route),method,b,now:time,send:(status,data)=>({status,data}),fail(status,message){throw Object.assign(Error(message),{status});},transaction(fn){db.exec('BEGIN');try{fn();db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}},log(){}});
  const unit=(id,who='controller')=>{db.prepare('INSERT INTO tracking_units(id,name,identifier,kind,notes,active,created_at,updated_at,internal_number) VALUES (?,?,?,?,?,1,?,?,?)').run(id,'Nombre privado '+id,'KIT-PRIVADO-'+id,'vehicle','Privado',stamp(base),stamp(base),'TRK-'+id);if(who)db.prepare('INSERT INTO tracking_unit_access VALUES (?,?)').run(id,who);};
  const gps=(id,u,created=base)=>db.prepare('INSERT INTO tracking_devices(id,unit_id,name,imei,psn,provider,created_at) VALUES (?,?,?,?,?,?,?)').run(id,u,'GPS privado',id==='gps'?'001234567890123':'991234567890123','PSN-PRIVADO-'+id,'rinho',stamp(created));
  const position=(u,at,{speed=null,lat=0,lon=0,source='rinho',device='gps'}={})=>db.prepare('INSERT INTO tracking_positions(unit_id,lat,lon,source,recorded_at,actor_id,device_id,speed) VALUES (?,?,?,?,?,?,?,?)').run(u,lat,lon,source,stamp(at),'root',device,speed);
  return {db,call,unit,gps,position,at(value){time=value;},run(value=time){evaluateAlerts(db,value);},events(type){return db.prepare('SELECT * FROM alert_events'+(type?' WHERE type=?':'')+' ORDER BY occurred_at,id').all(...(type?[type]:[]));}};
}

test('Alertas GB: conexiones independientes, umbrales, cierre sin repetición y nueva incidencia tras recuperación',t=>{
  const f=fixture(t),{db,call}=f;
  db.prepare('INSERT INTO gb_sims VALUES (?,?,?,?,?,?)').run('sim','SIM-PRIVADA','Operador',100000,'viewer',stamp(base));
  db.prepare('INSERT INTO gb_devices(id,kit,name,sim_id,capacity,allocated,owner_id,active,created_at,satellite_enabled,satellite_allocated,sim_allocated,controller_id,internal_number) VALUES (?,?,?,?,?,?,?,1,?,1,?,?,?,?)').run('gb','KIT-PRIVADO','Equipo privado','sim',100000,200000,'viewer',stamp(base),100000,100000,'controller','00012');
  const usage=(source,amount)=>db.prepare('INSERT INTO gb_usage(id,device_id,amount,date,note,actor_id,created_at,source) VALUES (?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),'gb',amount,'2026-10-21','SIM-PRIVADA','root',stamp(base),source);
  usage('satellite',80000);usage('sim',20000);f.run();f.run();assert.equal(f.events().length,1);
  let e=f.events()[0];assert.equal(e.severity,'warning');assert.equal(JSON.parse(e.details).channel,'satellite');
  assert.equal(call('controller','events/'+e.id+'/status','PATCH',{status:'ack'}).status,200);
  assert.equal(call('controller','events/'+e.id+'/status','PATCH',{status:'closed'}).status,200);
  f.run(base+30000);assert.equal(f.events().length,1);assert.equal(f.events()[0].status,'closed');
  usage('satellite',20000);f.run();assert.equal(f.events()[0].severity,'critical');assert.equal(f.events()[0].status,'closed');
  db.prepare('UPDATE gb_devices SET satellite_allocated=200000,allocated=300000 WHERE id=?').run('gb');f.run();assert.equal(f.events()[0].condition_active,0);
  usage('satellite',60000);f.run();assert.equal(f.events().length,2);
  usage('sim',60000);f.run();assert.equal(f.events().length,3);assert.equal(f.events().filter(e=>JSON.parse(e.details).channel==='sim').length,1);
  const visible=call('controller','dashboard?status=all').data;
  assert.equal(visible.total,3);assert.ok(visible.items.every(e=>e.internal_number==='00012'));
  for(const secret of ['KIT-PRIVADO','Equipo privado','SIM-PRIVADA'])assert.ok(!JSON.stringify(visible).includes(secret));
  assert.equal(call('other','dashboard?status=all').data.total,0);
  assert.equal(call('viewer','dashboard?status=all').data.total,3);
  assert.throws(()=>call('viewer','events/'+e.id+'/status','PATCH',{status:'closed'}),e=>e.status===403);
  assert.throws(()=>call('other','events/'+e.id),e=>e.status===404);
  assert.equal(call('admin','events/'+e.id).data.actions.length,2);
  assert.equal(call('admin','dashboard?status=all').data.items[0].real_identifier,'KIT-PRIVADO');
  call('admin','settings','PATCH',{gb_percent:90});f.run();assert.equal(f.events().filter(e=>e.condition_active).length,0);
  for(const value of [0,101,'80',null])assert.throws(()=>call('admin','settings','PATCH',{gb_percent:value}),e=>e.status===400);
});

test('Alertas GPS: primera muestra ausente, posiciones manuales, recuperación, archivo y aislamiento por unidad',t=>{
  const f=fixture(t);f.unit('u');f.gps('gps','u');f.unit('other','other');f.gps('gps2','other');f.position('other',base);
  f.run(base+29*60000);assert.equal(f.events('stale').length,0);
  f.position('u',base+31*60000,{source:'manual'});f.run(base+31*60000);assert.equal(f.events('stale').length,2);
  const mine=f.events('stale').find(e=>e.entity_id==='u');assert.equal(JSON.parse(mine.details).last_sample,null);
  f.position('u',base+32*60000);f.run(base+32*60000);assert.equal(f.events('stale').find(e=>e.id===mine.id).condition_active,0);
  f.at(base+32*60000);let result=f.call('controller','dashboard?status=all').data;assert.equal(result.total,1);assert.equal(result.items[0].entity_name,'TRK-u');
  assert.ok(!JSON.stringify(result).includes('KIT-PRIVADO'));assert.ok(!JSON.stringify(result).includes('001234567890123'));
  f.db.prepare('DELETE FROM tracking_unit_access WHERE unit_id=?').run('u');assert.equal(f.call('controller','dashboard?status=all').data.total,0);assert.throws(()=>f.call('controller','events/'+mine.id),e=>e.status===404);
  f.db.prepare('UPDATE tracking_units SET active=0 WHERE id=?').run('other');f.run(base+60*60000);assert.equal(f.events('stale').filter(e=>e.condition_active).length,0);
  assert.throws(()=>f.call('controller','configuration'),e=>e.status===403);assert.throws(()=>f.call('admin','configuration','GET',{},[]),e=>e.status===403);
});

test('Velocidad y zonas: procesa muestras intermedias, ignora manuales/futuras/tardías y conserva la línea de base',t=>{
  const f=fixture(t);f.unit('u');f.gps('gps','u');
  f.call('root','units/u/rule','PATCH',{stale_minutes:60,speed_limit:80});
  const zone=f.call('root','zones','POST',{unit_id:'u',name:'Base privada',lat:0,lon:0,radius:1,on_enter:true,on_exit:true,active:true}).data.id;
  f.position('u',base+1000,{lat:0.1,speed:20});f.position('u',base+2000,{lat:0,speed:100});f.position('u',base+3000,{lat:0.1,speed:10});
  f.position('u',base+4000,{lat:0,speed:200,source:'manual'});f.position('u',base+100000,{lat:0,speed:300});
  f.run(base+5000);assert.equal(f.events('speed').length,1);assert.equal(f.events('speed')[0].condition_active,0);assert.equal(f.events('enter').length,1);assert.equal(f.events('exit').length,1);
  assert.equal(f.events('enter')[0].occurred_at,stamp(base+2000));assert.equal(JSON.parse(f.events('enter')[0].details).zone_id,zone);
  f.run(base+6000);assert.equal(f.events('speed').length,1);assert.equal(f.events('enter').length,1);
  f.position('u',base+1500,{lat:0,speed:150});f.run(base+7000);assert.equal(f.events('speed').length,1);assert.equal(f.events('enter').length,1);
  f.at(base+7000);const panel=f.call('controller','dashboard?status=all').data;assert.equal(panel.total,3);assert.ok(!JSON.stringify(panel).includes('Base privada'));assert.ok(!JSON.stringify(panel).includes('Nombre privado'));
  assert.equal(f.call('root','configuration').data.zones[0].inside,0);
  assert.equal(inAlertZone(0,-179.999,{lat:0,lon:179.999,radius:1}),true);
  assert.equal(inAlertZone(0,0.1,{lat:0,lon:0,radius:1}),false);
  assert.throws(()=>f.call('controller','zones','POST',{}),e=>e.status===403);
  for(const patch of [{radius:0},{lat:91},{lon:-181},{on_enter:false,on_exit:false},{unit_id:'unknown'}])assert.throws(()=>f.call('root','zones','POST',{unit_id:'u',name:'Zona',lat:0,lon:0,radius:1,on_enter:true,on_exit:true,active:true,...patch}),e=>e.status===400);
  for(const patch of [{stale_minutes:0},{stale_minutes:1.5},{speed_limit:0},{speed_limit:'90'}])assert.throws(()=>f.call('root','units/u/rule','PATCH',{stale_minutes:30,speed_limit:null,...patch}),e=>e.status===400);
});

test('Bandeja de alertas: filtros y paginación conservan alcance; estados auditados y fuentes revocadas',t=>{
  const f=fixture(t);f.unit('u');f.gps('gps','u');f.call('root','units/u/rule','PATCH',{stale_minutes:null,speed_limit:80});
  for(let i=0;i<30;i++){f.position('u',base+i*2000,{speed:100});f.position('u',base+i*2000+1000,{speed:0});}
  f.at(base+60000);f.run();assert.equal(f.events().length,30);
  assert.equal(f.call('controller','dashboard?type=speed&source=tracking').data.items.length,25);assert.equal(f.call('controller','dashboard?page=2').data.items.length,5);
  assert.equal(f.call('controller','dashboard?severity=warning').data.total,0);assert.equal(f.call('controller','dashboard?q=TRK-u').data.total,30);
  assert.equal(f.call('controller','dashboard?q=KIT-PRIVADO').data.total,0);
  for(const query of ['page=0','page=1.5','status=BAD','source=unknown','severity=BAD','type=bad'])assert.throws(()=>f.call('controller','dashboard?'+query),e=>e.status===400);
  const event=f.events()[0];f.call('controller','events/'+event.id+'/status','PATCH',{status:'ack'});f.call('controller','events/'+event.id+'/status','PATCH',{status:'ack'});assert.equal(f.call('controller','events/'+event.id).data.actions.length,1);
  f.call('controller','events/'+event.id+'/status','PATCH',{status:'closed'});assert.equal(f.call('controller','dashboard?status=closed').data.total,1);f.call('controller','events/'+event.id+'/status','PATCH',{status:'open'});assert.equal(f.call('controller','events/'+event.id).data.actions.length,3);
  assert.equal(f.call('controller','dashboard','GET',{},[GB]).data.total,0);assert.throws(()=>f.call('controller','events/'+event.id,'GET',{},[GB]),e=>e.status===404);
  assert.throws(()=>f.call('admin','units/u/rule','PATCH',{stale_minutes:30,speed_limit:null},[GB]),e=>e.status===404);
});
