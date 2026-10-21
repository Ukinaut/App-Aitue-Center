import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export async function importChubut({sourceDir,dataDir=path.join(project,'data')}){
  const {readdirSync}=await import('node:fs');
  const files=readdirSync(sourceDir),dbName=files.find(n=>n.endsWith('.db')),htmlName=files.find(n=>n.endsWith('.html'));
  if(!dbName)throw Error('No se encontró la base SQLite en la carpeta de origen.');
  async function hash(file){const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
  const original=path.join(sourceDir,dbName),sha=await hash(original);
  const directory='argentina-petrolera-chubut-'+sha.slice(0,16),dest=path.join(dataDir,'industries',directory);
  mkdirSync(dest,{recursive:true});
  const pointer=path.join(dataDir,'industries','catalog.json');
  if(existsSync(path.join(dest,'manifest.json'))){
    const manifest=JSON.parse(readFileSync(path.join(dest,'manifest.json'),'utf8')),file=manifest.files.find(f=>f.kind==='database');
    if(file&&!file.original_sha256){file.original_sha256=file.sha256;file.sha256=await hash(path.join(dest,'source.sqlite'));file.preservation='Respaldo SQLite consistente';writeFileSync(path.join(dest,'manifest.json'),JSON.stringify(manifest,null,2));}
    writeFileSync(pointer,JSON.stringify({version:1,directory}));return manifest;
  }
  const source=new DatabaseSync(original,{readOnly:true});source.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF');
  try{
    for(const table of ['pozos','ultima_declaracion_chubut','atributos_geograficos','seguimiento_inactivos','imagenes_iniciales_satelitales','metadatos_base'])if(!source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))throw Error('La base no tiene la estructura esperada: '+table);
    const check=source.prepare('PRAGMA quick_check').get();if(Object.values(check)[0]!=='ok')throw Error('La base no superó la comprobación de integridad.');
    await backup(source,path.join(dest,'source.sqlite'));
  }finally{source.close();}
  if(htmlName)copyFileSync(path.join(sourceDir,htmlName),path.join(dest,'original-map.html'));
  const imported=new DatabaseSync(path.join(dest,'source.sqlite'),{readOnly:true});
  imported.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF');
  const index=new DatabaseSync(path.join(dest,'index.sqlite'));
  try{
    index.exec(`CREATE TABLE wells(id TEXT PRIMARY KEY,name TEXT,lat REAL,lon REAL,province TEXT,basin TEXT,area TEXT,field TEXT,company TEXT,state TEXT,period TEXT,well_type TEXT,resource TEXT,formation TEXT,followup INTEGER,priority TEXT,has_image INTEGER,has_fracture INTEGER);
    CREATE INDEX wells_coordinates ON wells(lat,lon);CREATE INDEX wells_state ON wells(state);CREATE INDEX wells_company ON wells(company);`);
    const rows=imported.prepare(`SELECT p.id_pozo id,p.sigla name,p.latitud_wgs84 lat,p.longitud_wgs84 lon,p.provincia province,p.cuenca basin,p.area,p.yacimiento field,COALESCE(NULLIF(u.empresa,''),p.empresa_declarada,'Sin informar') company,COALESCE(NULLIF(u.tipoestado,''),p.estado_declarado,'Sin informar') state,u.fecha_data period,COALESCE(NULLIF(u.tipopozo,''),p.tipo_pozo) well_type,g.tipo_recurso resource,g.formacion formation,CASE WHEN s.id_pozo IS NULL THEN 0 ELSE 1 END followup,s.prioridad_revision priority,EXISTS(SELECT 1 FROM imagenes_iniciales_satelitales im WHERE im.id_pozo=p.id_pozo) has_image,EXISTS(SELECT 1 FROM fracturas_declaradas f WHERE f.id_pozo=p.id_pozo) has_fracture FROM pozos p LEFT JOIN ultima_declaracion_chubut u ON u.idpozo=p.id_pozo LEFT JOIN atributos_geograficos g ON g.id_pozo=p.id_pozo LEFT JOIN seguimiento_inactivos s ON s.id_pozo=p.id_pozo`).all();
    const insert=index.prepare('INSERT INTO wells VALUES ('+Array(18).fill('?').join(',')+')');
    index.exec('BEGIN');try{for(const r of rows)insert.run(...Object.values(r));index.exec('COMMIT');}catch(e){index.exec('ROLLBACK');throw e;}
    const meta=Object.fromEntries(imported.prepare('SELECT clave,valor FROM metadatos_base').all().map(r=>[r.clave,r.valor]));
    const stats={...index.prepare('SELECT COUNT(*) wells,SUM(followup) followup,SUM(has_image) images,SUM(has_fracture) fractured,MIN(lat) south,MAX(lat) north,MIN(lon) west,MAX(lon) east FROM wells').get()};
    const manifest={version:1,country:'AR',country_name:'Argentina',sector:'oil',province:'Chubut',imported_at:new Date().toISOString(),prepared_at:meta.fecha_actualizacion||meta.fecha_preparacion,stats,files:[{kind:'database',name:dbName,bytes:statSync(path.join(dest,'source.sqlite')).size,sha256:await hash(path.join(dest,'source.sqlite')),original_sha256:sha,preservation:'Respaldo SQLite consistente'},...(htmlName?[{kind:'map',name:htmlName,bytes:statSync(path.join(sourceDir,htmlName)).size,sha256:await hash(path.join(sourceDir,htmlName))}]:[])],metadata:meta};
    writeFileSync(path.join(dest,'manifest.json'),JSON.stringify(manifest,null,2));writeFileSync(pointer,JSON.stringify({version:1,directory}));
    return manifest;
  }finally{index.close();imported.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const sourceDir=process.argv[2];if(!sourceDir)throw Error('Uso: node scripts/import-chubut.mjs <carpeta-de-origen>');
  const result=await importChubut({sourceDir:path.resolve(sourceDir),dataDir:process.env.DATA_DIR||path.join(project,'data')});console.log(`Importación completa: Argentina / Petrolera / Chubut · ${result.stats.wells} pozos · ${result.stats.images} imágenes. Los originales se conservaron sin modificar.`);
}
