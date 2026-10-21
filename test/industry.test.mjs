import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createIndustryStore, handleIndustry, industryFilter, locationEnvelope, mergeSectorZones } from '../industry.mjs';
import { importChubut } from '../scripts/import-chubut.mjs';
import { SATELLITE_APP } from '../satellite.mjs';

function fixture(t){
  const root=mkdtempSync(path.join(tmpdir(),'aitue-industry-test-')),directory='argentina-petrolera-chubut-0123456789abcdef',dest=path.join(root,'industries',directory);mkdirSync(dest,{recursive:true});
  const source=new DatabaseSync(path.join(dest,'source.sqlite'));
  source.exec(`CREATE TABLE pozos(id_pozo TEXT PRIMARY KEY,sigla TEXT,latitud_wgs84 REAL,longitud_wgs84 REAL,provincia TEXT,cuenca TEXT,area TEXT,yacimiento TEXT,empresa_declarada TEXT,tipo_pozo TEXT,estado_declarado TEXT);
  INSERT INTO pozos VALUES ('0','Pozo original',-45,-68,'Chubut','Cuenca','Área','Yacimiento','Empresa inventario','Petrolífero','En Estudio');
  CREATE TABLE ultima_declaracion_chubut(idpozo TEXT,empresa TEXT,tipoestado TEXT,fecha_data TEXT,tipopozo TEXT,idusuario TEXT);INSERT INTO ultima_declaracion_chubut VALUES ('0','Empresa DDJJ','Extracción Efectiva','2026-08','Petrolífero','private-source-id');
  CREATE TABLE atributos_geograficos(id_pozo TEXT,formacion TEXT,tipo_recurso TEXT);INSERT INTO atributos_geograficos VALUES ('0','Formación','Petróleo');
  CREATE TABLE seguimiento_inactivos(id_pozo TEXT,prioridad_revision TEXT);CREATE TABLE relaciones_territoriales_chubut(id_pozo TEXT);
  CREATE TABLE imagenes_iniciales_satelitales(id_pozo TEXT,escena_id TEXT,fecha_adquisicion TEXT,resolucion_m REAL,ancho_pixeles INTEGER,alto_pixeles INTEGER,nubosidad_recorte_pct REAL,control_calidad TEXT,imagen_jpeg BLOB);
  INSERT INTO imagenes_iniciales_satelitales VALUES ('0','Scene','2026-09-01',10,96,96,0,'Revisión pendiente',X'FFD81122FFD9');
  CREATE TABLE historial(id_pozo TEXT,fecha TEXT,tipo_evento TEXT,descripcion TEXT,fuente_url TEXT,calidad TEXT);INSERT INTO historial VALUES ('0','2020-01-01','Inicio','Declarado',NULL,'Declarado');
  CREATE TABLE fracturas_declaradas(id_pozo TEXT,fecha_inicio TEXT,fecha_fin TEXT,cantidad_fracturas INTEGER,agua_inyectada_m3 REAL,arena_nacional_t REAL,arena_importada_t REAL,control_fechas TEXT,empresa_informante TEXT);
  CREATE TABLE responsabilidades_areas(area_inventario TEXT,fecha_hecho TEXT);CREATE TABLE declaraciones_mensuales_2026(anio TEXT,mes TEXT);INSERT INTO declaraciones_mensuales_2026 VALUES ('2026','8'),('2026','8');
  CREATE TABLE metadatos_base(clave TEXT,valor TEXT);INSERT INTO metadatos_base VALUES ('fecha_actualizacion','2026-10-07');
  CREATE TABLE capas_territoriales_chubut(capa TEXT,gid TEXT,nombre TEXT,geometria_geojson TEXT,fuente_id TEXT);`);
  source.close();
  const index=new DatabaseSync(path.join(dest,'index.sqlite'));index.exec('CREATE TABLE wells(id TEXT PRIMARY KEY,name TEXT,lat REAL,lon REAL,province TEXT,basin TEXT,area TEXT,field TEXT,company TEXT,state TEXT,period TEXT,well_type TEXT,resource TEXT,formation TEXT,followup INTEGER,priority TEXT,has_image INTEGER,has_fracture INTEGER)');
  const insert=index.prepare('INSERT INTO wells VALUES ('+Array(18).fill('?').join(',')+')');index.exec('BEGIN');for(let i=0;i<2005;i++)insert.run(String(i),i===0?'Pozo_100%':`Pozo ${i}`,-45+i/100000,-68+i/100000,'Chubut','Cuenca','Área','Yacimiento',i%2?'Empresa B':'Empresa A',i%2?'En Estudio':'Extracción Efectiva','2026-08','Petrolífero','Petróleo','Formación',i%2,null,i===0?1:0,0);index.exec('COMMIT');index.close();
  writeFileSync(path.join(dest,'manifest.json'),JSON.stringify({version:1,stats:{wells:2005,west:-69,east:-67,south:-46,north:-44},prepared_at:'2026-10-07',files:[]}));writeFileSync(path.join(root,'industries','catalog.json'),JSON.stringify({directory}));
  const store=createIndustryStore({dataDir:root});t.after(()=>{store.close();if(path.dirname(root)===tmpdir()&&path.basename(root).startsWith('aitue-industry-test-'))rmSync(root,{recursive:true,force:true});});return {root,dest,store};
}

test('Zonas orientativas: envolvente cerrada sin puntos interiores ni áreas inventadas',()=>{
  assert.deepEqual(locationEnvelope([[0,0],[2,0],[2,2],[0,2],[1,1],[0,0]]),[[0,0],[2,0],[2,2],[0,2],[0,0]]);
  assert.equal(locationEnvelope([[0,0],[1,1],[2,2]]),null);
  assert.equal(locationEnvelope([[0,0],[0,0]]),null);
});

test('Zonas superpuestas: unión exterior sin divisiones internas, conserva islas y sectores',()=>{
  const box=(name,x1,y1,x2,y2,sector='oil')=>({type:'Feature',properties:{name,sector,wells:1},geometry:{type:'Polygon',coordinates:[[[x1,y1],[x2,y1],[x2,y2],[x1,y2],[x1,y1]]]}});
  const result=mergeSectorZones([box('A',0,0,2,2),box('B',1,0,3,2),box('Interior',.5,.5,1,1),box('Isla',10,0,11,1),box('Otro sector',0,0,2,2,'mining')]);
  assert.equal(result.length,2);assert.equal(result[0].geometry.coordinates.length,2);
  assert.deepEqual(result[0].geometry.coordinates[0],[[[0,0],[3,0],[3,2],[0,2],[0,0]]]);
  assert.equal(result[0].properties.wells,4);assert.deepEqual(result[0].properties.areas,['A','B','Interior','Isla']);
  assert.equal(result[1].properties.sector,'mining');assert.deepEqual(mergeSectorZones([]),[]);
  const ring=mergeSectorZones([box('Sur',0,0,3,1),box('Norte',0,2,3,3),box('Oeste',0,1,1,2),box('Este',2,1,3,2)]);
  assert.equal(ring[0].geometry.coordinates.length,1);assert.equal(ring[0].geometry.coordinates[0].length,2,'Conserva huecos reales sin rellenar zonas sin cobertura');
});
test('Sectores: país y cobertura, filtros, paginación y agrupación conservan todos los pozos',t=>{
  const {store}=fixture(t);const summary=store.summary('oil','AR',new URLSearchParams());assert.equal(summary.totals.wells,2005);assert.equal(summary.totals.followup,1002);assert.equal(summary.totals.images,1);
  const report=store.report(new URLSearchParams());assert.equal(report.metrics[0].value,2005);assert.equal(report.table.rows.reduce((sum,r)=>sum+r.wells,0),2005);assert.equal(report.charts[0].rows.reduce((sum,r)=>sum+r.value,0),2005);
  assert.equal(store.zones(new URLSearchParams({area:'Zona inexistente'})).features.length,0);
  assert.equal(store.catalog().sectors.length,5);assert.equal(store.summary('nuclear','AR',new URLSearchParams()).available,false);
  const first=store.wells(new URLSearchParams({limit:'50'})),next=store.wells(new URLSearchParams({limit:'50',page:'2'}));assert.equal(first.rows.length,50);assert.equal(new Set([...first.rows,...next.rows].map(r=>r.id)).size,100);
  assert.equal(store.wells(new URLSearchParams({q:'_100%'})).total,1);assert.equal(store.wells(new URLSearchParams({q:"' OR 1=1 --"})).total,0);
  const filtered=store.wells(new URLSearchParams({company:'Empresa B',followup:'yes'}));assert.equal(filtered.total,1002);
  const clustered=store.map(new URLSearchParams({zoom:'6'}));assert.equal(clustered.type,'clusters');assert.equal(clustered.features.reduce((sum,r)=>sum+r.n,0),2005);
  const point=store.map(new URLSearchParams({zoom:'14',q:'_100%'}));assert.equal(point.type,'points');assert.equal(point.features[0].id,'0');
  assert.equal(store.map(new URLSearchParams({bbox:'-70,-48,-69,-47'})).total,0);
  assert.throws(()=>store.map(new URLSearchParams({bbox:'-68,-45,200,90'})),e=>e.status===400);assert.throws(()=>store.wells(new URLSearchParams({limit:'99999'})),e=>e.status===400);assert.throws(()=>industryFilter(new URLSearchParams({followup:'maybe'})),e=>e.status===400);
  const detail=store.detail('0');assert.equal(detail.latest.empresa,'Empresa DDJJ');assert.equal('idusuario' in detail.latest,false);assert.equal(detail.history.length,1);assert.ok(store.image('0'));assert.equal(store.image('unknown'),null);assert.equal(store.detail('unknown'),null);
});
test('Sectores: permisos antes de leer datos y originales reservados a administradores',()=>{
  let calls=0;const store={catalog(){calls++;return {};},summary(){calls++;return {available:false};}};
  const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
  const request=(role,apps,route,method='GET')=>handleIndustry({store,actor:{role,apps},url:new URL('http://localhost/api/industry/'+route),method,send:(status,data)=>({status,data}),fail});
  assert.throws(()=>request('usuario',[],'catalog'),e=>e.status===403);assert.equal(calls,0);
  assert.equal(request('usuario',[SATELLITE_APP],'catalog').data.canDownloadOriginal,false);assert.equal(request('superadmin',[],'catalog').data.canDownloadOriginal,true);
  assert.equal(request('controlador',[SATELLITE_APP],'nuclear/AR/summary').data.available,false);
  assert.throws(()=>request('usuario',[SATELLITE_APP],'oil/AR/files/map'),e=>e.status===403);
  assert.throws(()=>request('superadmin',[],'oil/BR/summary'),e=>e.status===404);assert.throws(()=>request('superadmin',[],'catalog','POST'),e=>e.status===405);
});
test('Importación sectorial: respaldo consistente, índice reproducible y fuente intacta',async t=>{
  const {root,dest}=fixture(t),sourceDir=path.join(root,'input'),dataDir=path.join(root,'imported');mkdirSync(sourceDir);
  const bytes=readFileSync(path.join(dest,'source.sqlite'));writeFileSync(path.join(sourceDir,'sample.db'),bytes);writeFileSync(path.join(sourceDir,'sample.html'),'<html>Mapa aportado</html>');
  const a=await importChubut({sourceDir,dataDir}),b=await importChubut({sourceDir,dataDir});assert.equal(a.stats.wells,1);assert.equal(a.stats.images,1);assert.deepEqual(a,b);assert.ok(readFileSync(path.join(sourceDir,'sample.db')).equals(bytes));
  const imported=createIndustryStore({dataDir});try{assert.equal(imported.summary('oil','AR',new URLSearchParams()).totals.wells,1);assert.equal(imported.wells(new URLSearchParams()).rows[0].company,'Empresa DDJJ');assert.equal(imported.original('map').name,'sample.html');}finally{imported.close();}
});
