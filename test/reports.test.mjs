import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {initializeTracking,handleTracking,TRACKING_APP} from '../tracking.mjs';
import {handleSatellite,SATELLITE_APP} from '../satellite.mjs';
import {buildTrackingReport,buildSatelliteReport,reportPeriod} from '../reports.mjs';
import {reportCsv} from '../public/reports.js';

const now=Date.parse('2026-10-20T12:00:00Z');
test('Dashboard de Trackeo: filtros, conteos, fechas UTC e inventario sin inventar actividad',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec("CREATE TABLE users(id TEXT PRIMARY KEY);INSERT INTO users VALUES ('root');CREATE TABLE apps(id TEXT PRIMARY KEY,name TEXT,description TEXT,url TEXT,color TEXT);");initializeTracking(db);
  const add=db.prepare('INSERT INTO tracking_units VALUES (?,?,?,?,?,?,?,?)');add.run('a','Vehículo A','0001','vehicle','',1,'2026-01-01','2026-01-01');add.run('b','Aeronave B','0002','aircraft','',0,'2026-01-01','2026-01-01');
  db.exec("INSERT INTO tracking_devices(id,unit_id,name,provider,created_at) VALUES ('gps','a','GPS','rinho','2026-01-01');INSERT INTO tracking_cameras VALUES ('cam','gps','Frontal','1','hls','','2026-01-01');");
  const position=db.prepare('INSERT INTO tracking_positions(unit_id,lat,lon,source,recorded_at,actor_id,speed) VALUES (?,0,0,?,?,?,?)');
  position.run('a','manual','2026-10-20T10:00:00Z','root',null);position.run('a','rinho','2026-10-19T23:00:00Z','root',25);position.run('b','wialon','2026-10-19T11:00:00Z','root',100);position.run('a','rinho','2026-09-01T00:00:00Z','root',90);
  let report=buildTrackingReport(db,new URLSearchParams({days:'1'}),now);
  assert.equal(report.metrics[0].value,2);assert.equal(report.metrics[1].value,1);assert.equal(report.metrics[2].value,2);assert.equal(report.metrics[3].value,'1 / 1');
  assert.equal(report.table.rows[0].max_speed,25);assert.equal(report.table.rows[1].max_speed,null);assert.equal(report.table.rows[1].samples,0);
  assert.equal(report.charts.find(c=>c.type==='timeline').rows.reduce((s,r)=>s+r.value,0),2);
  report=buildTrackingReport(db,new URLSearchParams({days:'7',status:'archived'}),now);assert.equal(report.table.rows.length,1);assert.equal(report.table.rows[0].name,'Aeronave B');assert.equal(report.metrics[2].value,1);
  report=buildTrackingReport(db,new URLSearchParams({days:'7',unit:'a',source:'manual'}),now);assert.equal(report.metrics[2].value,1);assert.equal(report.table.rows[0].rinho,0);
  for(const query of [{days:'31'},{days:'0'},{days:'1.5'},{kind:"' OR 1=1 --"},{unit:'unknown'},{source:'fake'}])assert.throws(()=>buildTrackingReport(db,new URLSearchParams(query),now),e=>e.status===400);
});
test('Dashboard satelital: ventana de eventos, fuentes anteriores y clasificaciones sin inferir riesgo',()=>{
  const event=(id,time,category,source_id,level)=>({id,time,title:id,category,source_id,source:source_id,level});
  const data={events:[event('fire','2026-10-20T10:00:00Z','fire','gdacs','red'),event('quake','2026-10-19T23:00:00Z','earthquake','usgs','unknown'),event('old','2026-10-01T00:00:00Z','fire','gdacs','red'),event('future','2026-10-21T00:00:00Z','fire','gdacs','red')],sources:[{id:'gdacs',name:'GDACS',status:'stale',fetched_at:'2026-10-19T00:00:00Z'},{id:'usgs',name:'USGS',status:'ok',fetched_at:'2026-10-20T11:00:00Z'},{id:'eonet',name:'NASA EONET',status:'unavailable'}]};
  const report=buildSatelliteReport(data,new URLSearchParams({days:'1'}),now);assert.equal(report.metrics[0].value,2);assert.equal(report.metrics[1].value,1);assert.equal(report.metrics[3].value,2);
  assert.equal(report.table.rows.find(r=>r.title==='fire').source_status,'Datos anteriores');assert.equal(report.table.rows.find(r=>r.title==='quake').level,'Sin clasificación');
  assert.equal(report.charts.find(c=>c.type==='timeline').rows.reduce((s,r)=>s+r.value,0),2);
  assert.equal(buildSatelliteReport(data,new URLSearchParams({source:'eonet'}),now).metrics[0].value,0);
  assert.throws(()=>reportPeriod(new URLSearchParams({days:'30'}),7,now),e=>e.status===400);
});
test('CSV: incluye todas las filas y los indicadores, escapa fórmulas y conserva identificadores largos',()=>{
  const report={title:'Reporte',generated_at:'2026-10-20T12:00:00Z',period:{label:'Base'},scope:'Selección',notes:['Alcance'],metrics:[{label:'Total',value:26,hint:'Filas'}],charts:[{title:'Por tipo',rows:[{label:'Equipo',value:26}]}],table:{columns:[['name','Nombre'],['id','Identificador'],['value','Valor']],rows:Array.from({length:26},(_,i)=>({name:i===0?'=HYPERLINK("danger")':'Fila '+i,id:'001234567890101112131516171',value:i===0?-45:i}))}};
  const csv=reportCsv(report);assert.equal(csv.charCodeAt(0),0xfeff);assert.ok(csv.includes('Fila 25'));assert.ok(csv.includes('"Indicador";"Total";"26"'));assert.ok(csv.includes("'=HYPERLINK("));assert.ok(csv.includes("'001234567890101112131516171"));assert.ok(csv.includes('"-45"'));assert.equal(csv.includes('"\'-45"'),false);
});
test('Reportes: permisos comprobados antes de consultar datos',async()=>{
  const fail=(status,message)=>{throw Object.assign(Error(message),{status});};let calls=0;
  await assert.rejects(handleSatellite({actor:{role:'usuario',apps:[]},url:new URL('http://localhost/api/satellite/report'),method:'GET',send(){},fail,service:{events(){calls++;return {events:[],sources:[]};}}}),e=>e.status===403);
  assert.throws(()=>handleTracking({actor:{role:'usuario',apps:[]},url:new URL('http://localhost/api/tracking/report'),method:'GET',send(){},fail,db:{prepare(){calls++;throw Error('No debe consultar');}}}),e=>e.status===403);assert.equal(calls,0);
  const report=await handleSatellite({actor:{role:'usuario',apps:[SATELLITE_APP]},url:new URL('http://localhost/api/satellite/report?days=1'),method:'GET',send:(status,data)=>({status,data}),fail,service:{events:async options=>{assert.equal(options.includeAreas,false);return {events:[],sources:[]};}}});assert.equal(report.status,200);
});
