import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {initializeTracking,handleTracking,TRACKING_APP} from '../tracking.mjs';
import {reportCsv} from '../public/reports.js';

test('Trackeo: asignaciones directas, privacidad completa y revocación en todas las consultas',async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY);CREATE TABLE apps(id TEXT PRIMARY KEY,name TEXT,description TEXT,url TEXT,color TEXT);');
  const users=[['root','superadmin',true,[TRACKING_APP]],['admin','admin',true,[TRACKING_APP]],['c1','controlador',true,[TRACKING_APP]],['c2','controlador',true,[TRACKING_APP]],['child','usuario',true,[TRACKING_APP]],['blocked','usuario',true,[]],['inactive','usuario',false,[TRACKING_APP]]].map(([id,role,active,apps])=>({id,name:'Cuenta '+id,role,active,apps,parent_id:id==='child'?'c1':'root'}));
  for(const u of users)db.prepare('INSERT INTO users VALUES (?)').run(u.id);
  initializeTracking(db);
  const call=(who,route,method='GET',b={})=>handleTracking({db,users,actor:users.find(u=>u.id===who),service:{configured:()=>true},url:new URL('http://localhost/api/tracking/'+route),method,b,send:(status,data)=>({status,data}),fail(status,message){throw Object.assign(Error(message),{status});},log(){},transaction(fn){db.exec('BEGIN');try{fn();db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}});
  const unit={name:'Vehículo privado',identifier:'PATENTE-PRIVADA',kind:'vehicle',notes:'Nota privada',internal_number:'00007',user_ids:['c1','child']};
  const id=call('admin','units','POST',unit).data.id;
  const other=call('root','units','POST',{...unit,name:'Unidad ajena',identifier:'KIT-AJENO',internal_number:'TRK-OTHER',user_ids:['c2']}).data.id;
  const unassigned=call('root','units','POST',{...unit,identifier:'SIN-ASIGNAR',internal_number:'TRK-NONE',user_ids:[]}).data.id;
  for(const target of ['blocked','inactive','root','admin','unknown'])assert.throws(()=>call('admin','units/'+id+'/assignment','PATCH',{user_ids:[target]}),e=>e.status===400);
  for(const bad of [null,'c1',{},[null]])assert.throws(()=>call('admin','units/'+id+'/assignment','PATCH',{user_ids:bad}),e=>e.status===400);
  assert.throws(()=>call('root','units','POST',{...unit,identifier:'DUP'}),e=>e.status===409);
  assert.throws(()=>call('root','units/'+other,'PATCH',{...unit,internal_number:'trk-none'}),e=>e.status===409);
  const gpsBody={name:'GPS privado',unit_id:id,imei:'001234567890123',psn:'001234567890101112131516171',manufacturer:'Fabricante privado',model:'Modelo privado',provider:'rinho',external_id:'EXTERNO-PRIVADO'};
  const gps=call('root','devices','POST',gpsBody).data.id;
  const idleGps=call('root','devices','POST',{...gpsBody,name:'GPS sin unidad',unit_id:'',imei:'991234567890123',psn:'OTHER',external_id:'IDLE'}).data.id;
  const camera={device_id:gps,name:'Cámara privada',channel:'CANAL-PRIVADO',format:'hls',url:'https://video.test/neutro/index.m3u8'};
  const cam=call('root','cameras','POST',camera).data.id;
  call('root','units/'+id+'/position','POST',{lat:-45,lon:-68});
  call('root','units/'+other+'/position','POST',{lat:1,lon:1});
  for(const who of ['c1','child']){
    const panel=call(who,'dashboard').data;
    assert.equal(panel.units.length,1);assert.equal(panel.units[0].id,id);assert.equal(panel.units[0].name,'00007');assert.equal(panel.units[0].identifier,'00007');assert.equal(panel.devices.length,1);assert.equal(panel.cameras.length,1);
    assert.equal(panel.integrations,null);assert.deepEqual(panel.assignees,[]);assert.equal(panel.devices[0].id,gps);assert.ok(!panel.devices.some(d=>d.id===idleGps));
    const report=call(who,'report?days=1').data;
    assert.equal(report.options.units.length,1);assert.equal(report.metrics[0].value,1);assert.equal(report.metrics[2].value,1);assert.equal(report.metrics[3].value,'1 / 1');assert.equal(report.table.rows[0].name,'00007');
    for(const secret of [unit.name,unit.identifier,unit.notes,gpsBody.name,gpsBody.imei,gpsBody.psn,gpsBody.manufacturer,gpsBody.model,gpsBody.external_id,camera.name,camera.channel,camera.url,'Unidad ajena','KIT-AJENO','SIN-ASIGNAR']){
      assert.ok(!JSON.stringify(panel).includes(secret),secret+' en dashboard');assert.ok(!JSON.stringify(report).includes(secret),secret+' en reporte');assert.ok(!reportCsv(report).includes(secret),secret+' en CSV');
    }
    assert.equal(call(who,'units/'+id+'/history').data.positions.length,1);
    for(const target of [other,unassigned,'unknown']){
      assert.throws(()=>call(who,'units/'+target+'/history'),e=>e.status===404);
      assert.throws(()=>call(who,'report?unit='+target),e=>e.status===400);
    }
    assert.equal(call(who,'cameras/'+cam+'/playback').data.url,camera.url);
    for(const [route,method,body] of [['units/'+id+'/assignment','PATCH',{user_ids:[who]}],['units/'+id,'PATCH',unit],['devices/'+gps+'/ingest-key','POST',{}],['units/'+id+'/position','POST',{lat:0,lon:0}],['integrations/wialon/sync','POST',{}]])assert.throws(()=>call(who,route,method,body),e=>e.status===403);
  }
  assert.equal(call('admin','dashboard').data.units.length,3);assert.equal(call('admin','dashboard').data.devices[0].imei,gpsBody.imei);
  assert.equal(call('admin','report?unit='+id).data.table.rows[0].identifier,unit.identifier);
  // La jerarquía no hereda el acceso directo del subusuario.
  call('admin','units/'+id+'/assignment','PATCH',{user_ids:['child']});assert.equal(call('c1','dashboard').data.units.length,0);assert.equal(call('child','dashboard').data.units.length,1);
  assert.throws(()=>call('c1','units/'+id+'/history'),e=>e.status===404);assert.throws(()=>call('c1','cameras/'+cam+'/playback'),e=>e.status===404);
  assert.equal(call('c1','report').data.metrics[2].value,0);
  // Mover un GPS mueve las cámaras a la nueva unidad, sin mover el historial.
  call('admin','devices/'+gps,'PATCH',{...gpsBody,unit_id:other});
  assert.equal(call('child','dashboard').data.devices.length,0);assert.equal(call('child','dashboard').data.cameras.length,0);assert.throws(()=>call('child','cameras/'+cam+'/playback'),e=>e.status===404);
  assert.equal(call('child','units/'+id+'/history').data.positions.length,1);assert.equal(call('c2','dashboard').data.cameras.length,1);
  call('admin','cameras/'+cam,'PATCH',{...camera,url:'https://video.test/'+gpsBody.imei+'/live.m3u8'});
  assert.throws(()=>call('c2','cameras/'+cam+'/playback'),e=>e.status===409);
  assert.ok(call('admin','cameras/'+cam+'/playback').data.url.includes(gpsBody.imei));
  call('admin','units/'+other+'/assignment','PATCH',{user_ids:[]});assert.equal(call('c2','dashboard').data.units.length,0);assert.equal(call('c2','report').data.options.units.length,0);
  users.find(u=>u.id==='child').apps=[];assert.throws(()=>call('child','dashboard'),e=>e.status===403);assert.throws(()=>call('child','report'),e=>e.status===403);assert.throws(()=>call('child','cameras/'+cam+'/playback'),e=>e.status===403);
  initializeTracking(db);assert.equal(db.prepare('SELECT internal_number FROM tracking_units WHERE id=?').get(id).internal_number,'00007');assert.equal(db.prepare('SELECT COUNT(*) n FROM tracking_unit_access WHERE unit_id=?').get(id).n,1);
});

test('Trackeo: migración conserva inventario e historial y no concede acceso implícito',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY);INSERT INTO users VALUES ('root');CREATE TABLE apps(id TEXT PRIMARY KEY,name TEXT,description TEXT,url TEXT,color TEXT);
    CREATE TABLE tracking_units(id TEXT PRIMARY KEY,name TEXT,identifier TEXT UNIQUE,kind TEXT,notes TEXT,active INTEGER,created_at TEXT,updated_at TEXT);
    INSERT INTO tracking_units VALUES ('old','Privado','MATRICULA','vehicle','Nota',1,'2026-01-01','2026-01-01');
    CREATE TABLE tracking_positions(id INTEGER PRIMARY KEY,unit_id TEXT,lat REAL,lon REAL,source TEXT,recorded_at TEXT,actor_id TEXT);
    INSERT INTO tracking_positions VALUES (1,'old',-45,-68,'manual','2026-01-01','root');`);
  initializeTracking(db);initializeTracking(db);
  assert.equal(db.prepare('SELECT internal_number FROM tracking_units').get().internal_number,'TRK-000001');
  assert.equal(db.prepare('SELECT identifier FROM tracking_units').get().identifier,'MATRICULA');assert.equal(db.prepare('SELECT COUNT(*) n FROM tracking_positions').get().n,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM tracking_unit_access').get().n,0);
});
