import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeTracking, handleTracking, TRACKING_APP } from '../tracking.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWialonClient, normalizeWialonUnit } from '../tracking-wialon.mjs';

function trackingFixture(t,service={configured:()=>false}){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec("PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES ('root'); CREATE TABLE apps(id TEXT PRIMARY KEY,name TEXT,description TEXT,url TEXT,color TEXT);");initializeTracking(db);
  const call=(route,method='GET',b={},role='superadmin',apps=[])=>handleTracking({db,service,actor:{id:'root',role,apps},url:new URL('http://localhost/api/tracking/'+route),method,b,send:(status,data)=>({status,data}),fail(status,message){throw Object.assign(Error(message),{status});},log(){},transaction(fn){db.exec('BEGIN');try{fn();db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}});return {db,call};
}

test('GPS y cámaras: IMEI y PSN como texto, duplicados, asignaciones y permisos',t=>{
  const {db,call}=trackingFixture(t);const id=call('units','POST',{name:'Aeronave',identifier:'LV-TEST',kind:'aircraft'}).data.id;
  const other=call('units','POST',{name:'Persona',identifier:'PERSONA-TEST',kind:'person'}).data.id;
  const device={name:'GPS Rinho',unit_id:id,imei:'001234567890123',psn:'001234567890101112131516171',manufacturer:'Rinho',model:'Zero',provider:'rinho',external_id:''};
  const gps=call('devices','POST',device).data.id;
  const stored=call('dashboard').data.devices[0];assert.equal(stored.imei,device.imei);assert.equal(stored.psn,device.psn);assert.equal(typeof stored.psn,'string');
  assert.throws(()=>call('devices','POST',device),e=>e.status===409);
  assert.throws(()=>call('devices','POST',{...device,imei:'1',psn:'other'}),e=>e.status===400);
  assert.throws(()=>call('devices','POST',device,'usuario',[TRACKING_APP]),e=>e.status===403);
  assert.throws(()=>call('devices/'+gps+'/ingest-key','POST',{},'usuario',[TRACKING_APP]),e=>e.status===403);
  const key=call('devices/'+gps+'/ingest-key','POST',{}).data.key;
  const publicData=JSON.stringify(call('dashboard').data);
  assert.equal(publicData.includes(key),false);assert.equal(publicData.includes('ingest_hash'),false);assert.equal(publicData.includes('ingest_actor_id'),false);
  assert.equal(call('dashboard').data.devices[0].ingest_configured,1);
  const camera={device_id:gps,name:'Frontal',channel:'1',format:'hls',url:''};const cameraId=call('cameras','POST',camera).data.id;
  assert.equal(call('dashboard').data.cameras[0].device_id,gps);
  assert.throws(()=>call('cameras','POST',camera),e=>e.status===409);
  for(const url of ['javascript:alert(1)','http://user:password@camera.test/live.m3u8','file:///private'])assert.throws(()=>call('cameras/'+cameraId,'PATCH',{...camera,url}),e=>e.status===400);
  call('cameras/'+cameraId,'PATCH',{...camera,url:'https://camera.test/live.m3u8'});
  call('units/'+id+'/position','POST',{lat:-45,lon:-68});
  call('devices/'+gps,'PATCH',{...device,unit_id:other});
  assert.equal(call('dashboard').data.devices[0].unit_id,other);
  assert.equal(call('units/'+id+'/history').data.positions.length,1,'La reasignación no mueve posiciones históricas');
  assert.equal(call('units/'+other+'/history').data.positions.length,0);
  assert.equal(call('units/'+id+'/history','GET',{},'usuario',[TRACKING_APP]).data.positions.length,1);
  assert.throws(()=>call('units/'+id+'/history?hours=9999'),e=>e.status===400);
  initializeTracking(db);assert.equal(db.prepare('SELECT COUNT(*) n FROM tracking_devices').get().n,1);
});

test('Wialon: paginación, token en POST, cierre de sesión, errores sin secretos y servidor permitido',async()=>{
  const now=Date.now(),requests=[];
  const client=createWialonClient({token:'private-token',now:()=>now,fetcher:async(url,options)=>{
    assert.equal(url,'https://hst-api.wialon.com/wialon/ajax.html');assert.equal(url.includes('private-token'),false);assert.equal(options.redirect,'error');
    const body=options.body,svc=body.get('svc'),params=JSON.parse(body.get('params'));requests.push(svc);
    if(svc==='token/login'){assert.equal(params.token,'private-token');return Response.json({eid:'private-session'});}
    if(svc==='core/logout')return Response.json({error:0});
    assert.equal(params.flags,1281);assert.equal(body.get('sid'),'private-session');
    return Response.json({totalItemsCount:251,items:Array.from({length:params.from?1:250},(_,i)=>({id:params.from+i+1,nm:'Unidad '+(params.from+i+1),uid:'001234567890123',pos:{x:-68,y:-45,t:Math.floor(now/1000),s:12,z:100,c:90}}))});
  }});
  const [a,b]=await Promise.all([client.units(),client.units()]);assert.equal(a.length,251);assert.deepEqual(a,b);assert.deepEqual(requests,['token/login','core/search_items','core/search_items','core/logout']);
  assert.equal(JSON.stringify(a).includes('private-token'),false);assert.equal(JSON.stringify(a).includes('private-session'),false);
  assert.equal(a[0].position.speed,12);assert.equal(a[0].imei,'001234567890123');
  assert.equal(normalizeWialonUnit({id:1,nm:'Equipo',pos:{x:200,y:1,t:1}},now).position,null);
  let calls=0;const blocked=createWialonClient({token:'private-token',endpoint:'http://127.0.0.1:3100/',fetcher:async()=>{calls++;}});
  await assert.rejects(blocked.units(),e=>e.status===502&&!e.message.includes('private-token'));assert.equal(calls,0);
  await assert.rejects(createWialonClient({token:''}).units(),e=>e.status===409);
});

test('Sincronización Wialon: idempotencia, conflictos de IMEI y posiciones con hora original',async t=>{
  const now=Date.now(),time=new Date(now-60000).toISOString();let calls=0;
  const item={external_id:'123',name:'Equipo Wialon',imei:'001234567890123',position:{lat:-45,lon:-68,recorded_at:time,speed:12,altitude:100,heading:90}};
  const service={configured:()=>true,async units(){calls++;return [item];}};const {call,db}=trackingFixture(t,service);
  assert.throws(()=>call('integrations/wialon/sync','POST',{},'usuario',[TRACKING_APP]),e=>e.status===403);assert.equal(calls,0);
  let result=await call('integrations/wialon/sync','POST',{});assert.equal(result.data.created,1);assert.equal(result.data.positions,1);
  result=await call('integrations/wialon/sync','POST',{});assert.equal(result.data.created,0);assert.equal(result.data.positions,0);
  const unit=call('dashboard').data.units[0];assert.equal(unit.recorded_at,time);assert.equal(unit.source,'wialon');assert.equal(unit.speed,12);
  call('units/'+unit.id+'/position','POST',{lat:-46,lon:-69});
  assert.equal(call('dashboard').data.units[0].source,'manual','Un reporte GPS anterior no reemplaza una ubicación más reciente');
  const historic=new Date(now-120000).toISOString();item.position={...item.position,recorded_at:historic};await call('integrations/wialon/sync','POST',{});
  const history=call('units/'+unit.id+'/history').data.positions;assert.equal(history.length,3);assert.equal(history[0].recorded_at,historic);
  item.external_id='456';result=await call('integrations/wialon/sync','POST',{});assert.equal(result.data.conflicts,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM tracking_units').get().n,1);
});

test('Trackeo: permisos, persistencia de posiciones manuales y archivo reversible',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES ('root'); CREATE TABLE apps(id TEXT PRIMARY KEY,name TEXT,description TEXT,url TEXT,color TEXT);");
  initializeTracking(db);initializeTracking(db);assert.equal(db.prepare('SELECT COUNT(*) n FROM apps').get().n,1);
  const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
  const call=(route,method='GET',b={},role='superadmin',apps=[])=>handleTracking({db,actor:{id:'root',role,apps},url:new URL('http://localhost/api/tracking/'+route),method,b,send:(status,data)=>({status,data}),fail,log(){},transaction(fn){db.exec('BEGIN');try{fn();db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}});
  assert.throws(()=>call('dashboard','GET',{},'admin'),e=>e.status===403);
  assert.equal(call('dashboard','GET',{},'usuario',[TRACKING_APP]).data.canManage,false);
  assert.throws(()=>call('units','POST',{name:'Unit'},'usuario',[TRACKING_APP]),e=>e.status===403);
  const body={name:'Kit de seguimiento',identifier:'KIT-001',kind:'equipment',notes:'Alta manual'};
  const id=call('units','POST',body).data.id;
  assert.throws(()=>call('units','POST',body),e=>e.status===409);
  assert.throws(()=>call('units','POST',{...body,identifier:'2',kind:'invalid'}),e=>e.status===400);
  assert.throws(()=>call('units/'+id+'/position','POST',{lat:null,lon:0}),e=>e.status===400);
  assert.throws(()=>call('units/'+id+'/position','POST',{lat:91,lon:0}),e=>e.status===400);
  call('units/'+id+'/position','POST',{lat:0,lon:0,source:'gps'});
  call('units/'+id+'/position','POST',{lat:-45,lon:-68});
  const result=call('dashboard').data;assert.equal(result.units[0].lat,-45);assert.equal(result.units[0].source,'manual');assert.equal(result.gpsConnected,false);assert.equal(result.videoConnected,false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tracking_positions').get().n,2);
  call('units/'+id+'/status','PATCH',{active:false});
  assert.throws(()=>call('units/'+id+'/position','POST',{lat:0,lon:0}),e=>e.status===400);
  call('units/'+id+'/status','PATCH',{active:true});assert.equal(call('dashboard').data.units[0].active,1);
  assert.equal(call('dashboard').data.units[0].lon,-68);
});

test('Trackeo: registro integrado, sesión, acceso por aplicación y bloqueo de escrituras del usuario',async t=>{
  const dir=mkdtempSync(path.join(tmpdir(),'aitue-tracking-test-'));
  const child=spawn(process.execPath,[fileURLToPath(new URL('../server.mjs',import.meta.url))],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir},stdio:['ignore','pipe','pipe']});
  const stopped=new Promise(resolve=>child.once('exit',resolve));
  t.after(async()=>{child.kill();await stopped;if(path.dirname(dir)===tmpdir()&&path.basename(dir).startsWith('aitue-tracking-test-'))rmSync(dir,{recursive:true,force:true});});
  const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Servidor no disponible')),10000);child.stdout.on('data',chunk=>{const match=chunk.toString().match(/http:\/\/[^\s]+/);if(match){clearTimeout(timer);resolve(match[0]);}});child.once('error',reject);});
  const client=()=>({cookie:'',async call(route,body,method=body?'POST':'GET'){const r=await fetch(origin+'/api/'+route,{method,headers:{'X-Aitue-Request':'1','Content-Type':'application/json',Cookie:this.cookie},...(body?{body:JSON.stringify(body)}:{})});if(r.headers.get('set-cookie'))this.cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,data:await r.json()};}});
  const root=client(),viewer=client(),password='Tracking-test-pass-2026';
  assert.equal((await viewer.call('tracking/dashboard')).status,401);
  await root.call('setup',{name:'Root',email:'root@tracking.test',password});
  assert.equal((await root.call('apps/'+TRACKING_APP+'/launch')).data.url,'/?app=trackeo-video');
  await root.call('users',{name:'Viewer',email:'viewer@tracking.test',password,role:'usuario',apps:[],can_create:false});
  await viewer.call('login',{email:'viewer@tracking.test',password});assert.equal((await viewer.call('tracking/dashboard')).status,403);
  const id=(await root.call('dashboard')).data.users.find(u=>u.email==='viewer@tracking.test').id;
  await root.call('users/'+id,{apps:[TRACKING_APP]},'PATCH');await viewer.call('login',{email:'viewer@tracking.test',password});
  assert.equal((await viewer.call('tracking/dashboard')).status,200);
  assert.equal((await viewer.call('tracking/units',{name:'blocked',identifier:'test',kind:'camera'})).status,403);
  assert.equal((await root.call('tracking/dashboard')).data.units.length,0);
});
