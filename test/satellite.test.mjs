import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSatelliteService, handleSatellite, initializeSatellite, normalizeEvents, normalizeGdacsAreas, normalizeWeather, SATELLITE_APP } from '../satellite.mjs';
import { areaGeometry, areaCenter, mapAreaCopies } from '../public/satellite-geometry.js';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const start=Date.parse('2026-10-20T12:30:00Z');
const quake={type:'FeatureCollection',features:[{id:'one',geometry:{type:'Point',coordinates:[-58,-34,12]},properties:{title:'M 4.1 - Test',mag:4.1,place:'Zona de prueba',time:start-10000,updated:start,status:'reviewed',alert:null,url:'https://earthquake.usgs.gov/earthquakes/eventpage/test'}}]};
const met={properties:{meta:{updated_at:'2026-10-20T11:00:00Z'},timeseries:[12,13,14].map(hour=>({time:`2026-10-20T${hour}:00:00Z`,data:{instant:{details:{air_temperature:20,relative_humidity:60,wind_speed:10,wind_from_direction:90,cloud_area_fraction:10,air_pressure_at_sea_level:1015}},next_1_hours:{summary:{symbol_code:'clearsky_day'},details:{precipitation_amount:0}}}}))}};
const polygon={type:'Polygon',coordinates:[[[10,10],[12,10],[12,12],[10,12],[10,10]],[[10.5,10.5],[10.5,11],[11,11],[11,10.5],[10.5,10.5]]]};
test('Áreas: conserva perímetros y huecos, rechaza coordenadas inválidas y corrige el antimeridiano',()=>{
  assert.deepEqual(areaGeometry(polygon),polygon);assert.equal(mapAreaCopies(polygon)[0].coordinates.length,2);
  assert.equal(areaGeometry({type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[2,2]]]}),null);
  assert.equal(areaGeometry({type:'Polygon',coordinates:[[[181,0],[1,0],[1,1],[181,0]]]}),null);
  assert.equal(areaGeometry({type:'MultiPolygon',coordinates:[]}),null);
  const crossing={type:'Polygon',coordinates:[[[170,10],[-170,10],[-170,20],[170,20],[170,10]]]};
  const copies=mapAreaCopies(crossing);assert.equal(copies.length,2);
  for(const copy of copies){const xs=copy.coordinates[0].map(p=>p[0]);assert.equal(Math.max(...xs)-Math.min(...xs),20);}
  assert.equal(areaCenter(crossing).lat,15);assert.equal(Math.abs(areaCenter(crossing).lon),180);
  const nasa=normalizeEvents('eonet',{events:[{id:'area',title:'Incendio con perímetro',categories:[{id:'wildfires'}],geometry:[{...polygon,date:'2026-10-20T12:00:00Z'}]}]})[0];
  assert.equal(nasa.lat,11);assert.equal(nasa.lon,11);assert.equal(nasa.area_status,'provided');assert.deepEqual(nasa.area.features[0].geometry,polygon);
});
test('Áreas GDACS: usa polígonos de la fuente y separa geometrías futuras de las vigentes',()=>{
  const feature=(date,kind='WindRadii')=>({type:'Feature',geometry:polygon,properties:{polygondate:date,polygonlabel:'Viento',featuretype:kind}});
  const result=normalizeGdacsAreas({features:[feature('2026-10-19T12:00:00'),feature('2026-10-20T12:00:00'),feature('2026-10-21T12:00:00'),{geometry:{type:'Point',coordinates:[11,11]},properties:{}}]},{time:'2026-10-20T12:00:00Z'});
  assert.equal(result.features.length,1);assert.equal(result.features[0].properties.time,'2026-10-20T12:00:00.000Z');assert.ok(result.features[0].properties.label.includes('modelada'));
  assert.deepEqual(result.features[0].geometry,polygon);
  const generated=normalizeGdacsAreas({features:[feature('2026-10-20T12:00:03','AffectedArea')]},{time:'2026-10-20T12:00:00Z'});assert.equal(generated.features.length,1);
});
test('Áreas GDACS: consulta identificadores seguros, comparte caché y conserva reportes si falta el perímetro',async()=>{
  let calls=0,now=start,offline=false;
  const gdacs={features:[{geometry:{type:'Point',coordinates:[11,11]},properties:{eventtype:'FL',eventid:123,episodeid:4,name:'Inundación',todate:'2026-10-20T12:00:00'}}]};
  const service=createSatelliteService({now:()=>now,fetcher:async url=>{calls++;let data;
    if(url.includes('/polygons/')){assert.equal(new URL(url).hostname,'www.gdacs.org');assert.equal(new URL(url).searchParams.get('eventid'),'123');if(offline)throw Error('Sin geometría');data={features:[{geometry:polygon,properties:{polygonlabel:'Affected Area'}}]};}
    else if(url.includes('gdacs.org'))data=gdacs;else if(url.includes('eonet'))data={events:[]};else data={features:[]};return new Response(JSON.stringify(data));}});
  const first=await service.events();assert.equal(calls,4);assert.equal(first.events[0].area_status,'provided');assert.equal(first.events[0].area.features.length,1);
  await service.events();assert.equal(calls,4);
  now+=16*60000;offline=true;assert.equal((await service.events()).events[0].area_status,'stale');
  now+=25*3600000;const last=await service.events();assert.equal(last.events.length,1);assert.equal(last.events[0].area_status,'unavailable');assert.equal(last.events[0].area,null);
});
test('Reporte satelital: fuentes reales normalizadas sin inventar niveles ni ráfagas',()=>{
  const e=normalizeEvents('usgs',quake)[0];assert.equal(e.level,'unknown');assert.equal(e.lat,-34);assert.equal(e.magnitude,'M 4.1');assert.equal(e.time,'2026-10-20T12:29:50.000Z');
  assert.equal(normalizeEvents('usgs',{features:[{...quake.features[0],geometry:{type:'Point',coordinates:['-58',-34]}}]}).length,0);
  const nasa=normalizeEvents('eonet',{events:[{id:'fire',title:'<b>Incendio</b>',categories:[{id:'wildfires'}],sources:[{url:'javascript:alert(1)'}],link:'https://eonet.gsfc.nasa.gov/api/v3/events/fire',geometry:[{type:'Point',coordinates:[0,1],date:'2026-10-19T12:00:00Z'},{type:'Point',coordinates:[2,3],date:'2026-10-20T12:00:00Z'}]}]})[0];
  assert.equal(nasa.category,'fire');assert.equal(nasa.title,'Incendio');assert.equal(nasa.lat,3);assert.equal(nasa.level,'unknown');assert.ok(nasa.url.startsWith('https://eonet'));
  const feature={geometry:{type:'Point',coordinates:[1,2]},properties:{eventtype:'FL',eventid:1,name:'Inundación',alertlevel:'Orange',todate:'2026-10-20T12:00:00',url:{report:'https://www.gdacs.org/report.aspx?eventid=1'}}};
  const gdacs=normalizeEvents('gdacs',{features:[feature,feature]});assert.equal(gdacs.length,1);assert.equal(gdacs[0].level,'orange');assert.equal(gdacs[0].time,'2026-10-20T12:00:00.000Z');
  const weather=normalizeWeather(met,start);assert.equal(weather.current.wind,36);assert.equal(weather.current.gust,null);assert.equal(weather.current.precipitation,0);assert.equal(weather.current.time,'2026-10-20T12:00:00.000Z');assert.equal(weather.hourly.length,3);
});

test('Reporte satelital: caché compartida, fallas parciales y datos anteriores identificados',async()=>{
  let now=start,calls=0,offline=false;
  const service=createSatelliteService({now:()=>now,fetcher:async url=>{calls++;if(offline||url.includes('gdacs.org'))throw Error('Sin conexión');return new Response(JSON.stringify(url.includes('eonet')?{events:[]}:url.includes('api.met.no')?met:quake),{headers:{'Content-Type':'application/json'}});}});
  const first=await service.events();assert.equal(first.partial,true);assert.equal(first.events.length,1);assert.equal(first.sources.find(s=>s.id==='gdacs').status,'unavailable');assert.equal(calls,3);
  await Promise.all([service.events(),service.events()]);assert.equal(calls,3);
  await service.weather(-34,-58);await service.weather(-34,-58);assert.equal(calls,4);
  now+=11*60000;offline=true;const old=await service.events();assert.equal(old.events.length,1);assert.equal(old.sources.find(s=>s.id==='usgs').status,'stale');assert.equal(old.sources.find(s=>s.id==='usgs').fetched_at,new Date(start).toISOString());
  assert.equal((await service.weather(-34,-58)).status,'stale');
  now+=25*3600000;const expired=await service.events();assert.equal(expired.events.length,0);assert.ok(expired.sources.every(s=>s.status==='unavailable'));
});

test('Reporte satelital: registro idempotente y permiso validado antes de consultar fuentes',async()=>{
  const db=new DatabaseSync(':memory:');try{db.exec('CREATE TABLE apps(id TEXT PRIMARY KEY,name TEXT,description TEXT,url TEXT,color TEXT)');initializeSatellite(db);initializeSatellite(db);assert.equal(db.prepare('SELECT COUNT(*) n FROM apps').get().n,1);}finally{db.close();}
  let calls=0;const service={events:async()=>{calls++;return {events:[]};},search:async()=>{calls++;return {status:'ok',results:[]};},weather:async(lat,lon)=>{calls++;return {status:'ok',lat,lon};}};
  const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
  const request=(role,apps,route,method='GET')=>handleSatellite({actor:{role,apps},url:new URL('http://localhost/api/satellite/'+route),method,send:(status,data)=>({status,data}),fail,service});
  await assert.rejects(request('usuario',[],'events'),e=>e.status===403);assert.equal(calls,0);
  assert.equal((await request('superadmin',[],'events')).status,200);
  assert.equal((await request('controlador',[SATELLITE_APP],'events')).status,200);
  for(const route of ['weather','weather?lat=&lon=0','weather?lat=91&lon=0','weather?lat=0&lon=abc','search?q=ab'])await assert.rejects(request('admin',[SATELLITE_APP],route),e=>e.status===400);
  assert.equal(calls,2);
  assert.equal((await request('usuario',[SATELLITE_APP],'weather?lat=-34.567891&lon=-58.4')).data.lat,-34.57);
  await assert.rejects(request('superadmin',[],'events','POST'),e=>e.status===405);
  await assert.rejects(request('superadmin',[],'unknown'),e=>e.status===404);
});

test('Reporte satelital: sesión, lanzamiento y revocación de acceso por HTTP',async t=>{
  const dir=mkdtempSync(path.join(tmpdir(),'aitue-satellite-test-'));
  const child=spawn(process.execPath,[fileURLToPath(new URL('../server.mjs',import.meta.url))],{env:{...process.env,PORT:'0',DATA_DIR:dir},stdio:['ignore','pipe','pipe']});
  const stopped=new Promise(resolve=>child.once('exit',resolve));
  t.after(async()=>{child.kill();await stopped;if(path.dirname(dir)===tmpdir()&&path.basename(dir).startsWith('aitue-satellite-test-'))rmSync(dir,{recursive:true,force:true});});
  const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Servidor no disponible')),10000);child.stdout.on('data',chunk=>{const match=chunk.toString().match(/http:\/\/[^\s]+/);if(match){clearTimeout(timer);resolve(match[0]);}});child.once('error',reject);});
  const client=()=>({cookie:'',async call(route,body,method=body?'POST':'GET'){const r=await fetch(origin+'/api/'+route,{method,headers:{'X-Aitue-Request':'1','Content-Type':'application/json',Cookie:this.cookie},...(body?{body:JSON.stringify(body)}:{})});if(r.headers.get('set-cookie'))this.cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,data:await r.json()};}});
  const root=client(),reader=client(),password='Satellite-test-pass-2026';
  assert.equal((await reader.call('satellite/events')).status,401);
  assert.equal((await root.call('setup',{name:'Root',email:'root@satellite.test',password})).status,201);
  assert.equal((await root.call('apps/'+SATELLITE_APP+'/launch')).data.url,'/?app=reporte-satelital');
  await root.call('users',{name:'Reader',email:'reader@satellite.test',password,role:'usuario',apps:[],can_create:false});
  await reader.call('login',{email:'reader@satellite.test',password});
  assert.equal((await reader.call('satellite/events')).status,403);
  const id=(await root.call('dashboard')).data.users.find(u=>u.role==='usuario').id;
  await root.call('users/'+id,{apps:[SATELLITE_APP]},'PATCH');
  await reader.call('login',{email:'reader@satellite.test',password});
  assert.equal((await reader.call('satellite/weather?lat=invalid&lon=0')).status,400);
  assert.equal((await reader.call('satellite/events',{})).status,405);
  assert.equal((await reader.call('apps/'+SATELLITE_APP+'/launch')).status,200);
  await root.call('users/'+id,{apps:[]},'PATCH');
  assert.equal((await reader.call('satellite/weather?lat=0&lon=0')).status,401);
  await reader.call('login',{email:'reader@satellite.test',password});
  assert.equal((await reader.call('satellite/events')).status,403);
  assert.equal((await reader.call('apps/'+SATELLITE_APP+'/launch')).status,403);
});
