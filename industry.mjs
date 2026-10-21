import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import polygonClipping from 'polygon-clipping';
import { SATELLITE_APP } from './satellite.mjs';

export const sectors={oil:'Petrolera',mining:'Mineras',agriculture:'Agrícola',nuclear:'Nuclear',renewable:'Renovable'};
export function mergeSectorZones(features){
  const groups=new Map();
  for(const feature of features){const sector=feature.properties.sector;if(!groups.has(sector))groups.set(sector,[]);groups.get(sector).push(feature);}
  return [...groups].map(([sector,items])=>({type:'Feature',properties:{
    sector,name:items.length===1?items[0].properties.name:'Zonas '+(sectors[sector]||sector).toLowerCase()+' combinadas',
    areas:items.map(f=>f.properties.name),wells:items.reduce((sum,f)=>sum+f.properties.wells,0),
    boundary:'Contorno orientativo de ubicaciones; no es un límite de concesión'
  },geometry:{type:'MultiPolygon',coordinates:polygonClipping.union(...items.map(f=>f.geometry.coordinates))}}));
}
// Convex envelope of recorded locations, never a concession or administrative boundary.
export function locationEnvelope(coordinates){
  const sorted=[...new Map(coordinates.map(p=>[p.join(','),p])).values()].sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  if(sorted.length<3)return null;
  const cross=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);
  const half=points=>{const h=[];for(const p of points){while(h.length>=2&&cross(h.at(-2),h.at(-1),p)<=0)h.pop();h.push(p);}return h;};
  const lower=half(sorted),upper=half([...sorted].reverse());lower.pop();upper.pop();const ring=[...lower,...upper];
  return ring.length>=3?[...ring,ring[0]]:null;
}
const invalid=message=>{throw Object.assign(Error(message),{status:400});};
const integer=(value,fallback,min,max)=>{if(value===null)return fallback;const n=Number(value);if(!Number.isInteger(n)||n<min||n>max)invalid('Parámetro numérico inválido.');return n;};
export function industryFilter(params){
  const terms=[],values=[];
  for(const [param,column] of [['state','state'],['company','company'],['basin','basin'],['area','area']]){
    const value=(params.get(param)||'').trim();if(value.length>250)invalid('Filtro demasiado largo.');if(value){terms.push(column+'=?');values.push(value);}
  }
  const q=(params.get('q')||'').trim();if(q.length>120)invalid('Búsqueda demasiado larga.');
  if(q){terms.push("(id LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR field LIKE ? ESCAPE '\\')");const search='%'+q.replace(/[\\%_]/g,c=>'\\'+c)+'%';values.push(search,search,search);}
  const followup=params.get('followup')||'';if(followup&&!['yes','no'].includes(followup))invalid('Filtro de seguimiento inválido.');if(followup){terms.push('followup=?');values.push(followup==='yes'?1:0);}
  return {where:terms.length?'WHERE '+terms.join(' AND '):'',values};
}
export function createIndustryStore({dataDir}){
  let cache;
  function dataset(){
    const pointer=path.join(dataDir,'industries','catalog.json');if(!existsSync(pointer))return null;
    const {directory}=JSON.parse(readFileSync(pointer,'utf8'));if(!/^argentina-petrolera-chubut-[a-f0-9]{16}$/.test(directory))throw Error('Catálogo de datos inválido.');
    if(cache?.directory===directory)return cache;
    cache?.index.close();cache?.source.close();
    const root=path.join(dataDir,'industries',directory),manifest=JSON.parse(readFileSync(path.join(root,'manifest.json'),'utf8'));
    const index=new DatabaseSync(path.join(root,'index.sqlite'),{readOnly:true}),source=new DatabaseSync(path.join(root,'source.sqlite'),{readOnly:true});
    index.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF');source.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF');
    cache={directory,root,manifest,index,source};return cache;
  }
  const all=(db,sql,...args)=>db.prepare(sql).all(...args),one=(db,sql,...args)=>db.prepare(sql).get(...args)||null;
  function catalog(){const d=dataset();return {countries:[{id:'AR',name:'Argentina'}],sectors:Object.entries(sectors).map(([id,name])=>({id,name,countries:[{id:'AR',name:'Argentina',available:id==='oil'&&!!d,provinces:id==='oil'&&d?['Chubut']:[]}]}))};}
  function summary(sector,country,params){
    if(!sectors[sector]||country!=='AR')invalid('País o sector no disponible.');
    const d=sector==='oil'?dataset():null;if(!d)return {available:false,sector,country:'Argentina'};
    const {where,values}=industryFilter(params);
    const totals=one(d.index,`SELECT COUNT(*) wells,COALESCE(SUM(followup),0) followup,COALESCE(SUM(has_image),0) images,COALESCE(SUM(has_fracture),0) fractured FROM wells ${where}`,...values);
    const options=column=>all(d.index,`SELECT DISTINCT ${column} value FROM wells WHERE ${column} IS NOT NULL AND ${column}<>'' ORDER BY ${column}`).map(r=>r.value);
    return {available:true,sector,country:'Argentina',province:'Chubut',totals,dataset_totals:d.manifest.stats,prepared_at:d.manifest.prepared_at,imported_at:d.manifest.imported_at,options:{states:options('state'),companies:options('company'),basins:options('basin'),areas:options('area')},states:all(d.index,`SELECT state,COUNT(*) n FROM wells ${where} GROUP BY state ORDER BY n DESC`,...values),periods:all(d.source,'SELECT anio year,mes month,COUNT(*) n FROM declaraciones_mensuales_2026 GROUP BY anio,mes ORDER BY CAST(anio AS INTEGER),CAST(mes AS INTEGER)'),files:d.manifest.files.map(({kind,name,bytes,sha256,original_sha256,preservation})=>({kind,name,bytes,sha256,original_sha256,preservation}))};
  }
  function requireData(){const d=dataset();if(!d)throw Object.assign(Error('Todavía no hay un conjunto de datos importado.'),{status:404});return d;}
  function wells(params){const d=requireData(),{where,values}=industryFilter(params),page=integer(params.get('page'),1,1,1000000),limit=integer(params.get('limit'),50,1,100);const total=one(d.index,`SELECT COUNT(*) n FROM wells ${where}`,...values).n;return {rows:all(d.index,`SELECT * FROM wells ${where} ORDER BY name,id LIMIT ? OFFSET ?`,...values,limit,(page-1)*limit),page,limit,total};}
  function map(params){
    const d=requireData(),filter=industryFilter(params),zoom=integer(params.get('zoom'),6,1,19);
    let bounds=[d.manifest.stats.west,d.manifest.stats.south,d.manifest.stats.east,d.manifest.stats.north];
    if(params.has('bbox')){bounds=params.get('bbox').split(',').map(Number);if(bounds.length!==4||bounds.some(n=>!Number.isFinite(n))||bounds[0]<-180||bounds[2]>180||bounds[1]<-90||bounds[3]>90||bounds[0]>=bounds[2]||bounds[1]>=bounds[3])invalid('Extensión de mapa inválida.');}
    const where=filter.where+(filter.where?' AND ':'WHERE ')+'lon>=? AND lat>=? AND lon<=? AND lat<=?',values=[...filter.values,...bounds];
    const total=one(d.index,`SELECT COUNT(*) n FROM wells ${where}`,...values).n;
    if(total<=1000)return {type:'points',total,features:all(d.index,`SELECT id,name,lat,lon,state,company,period,followup,has_image FROM wells ${where}`,...values)};
    let cell=360/(2**Math.min(zoom,16)*16),groups;
    for(let i=0;i<12;i++){
      groups=all(d.index,`SELECT CAST((lon+180)/? AS INTEGER) gx,CAST((lat+90)/? AS INTEGER) gy,COUNT(*) n,AVG(lat) lat,AVG(lon) lon,SUM(followup) followup,MIN(id) id,MIN(name) name FROM wells ${where} GROUP BY gx,gy`,cell,cell,...values);
      if(groups.length<=1000)break;cell*=2;
    }
    return {type:'clusters',total,features:groups};
  }
  function detail(id){
    const d=requireData(),record=one(d.index,'SELECT * FROM wells WHERE id=?',id);if(!record)return null;
    const latest=one(d.source,'SELECT * FROM ultima_declaracion_chubut WHERE idpozo=? LIMIT 1',id);if(latest)delete latest.idusuario;
    return {record,inventory:one(d.source,'SELECT * FROM pozos WHERE id_pozo=?',id),latest,geography:one(d.source,'SELECT * FROM atributos_geograficos WHERE id_pozo=?',id),territory:one(d.source,'SELECT * FROM relaciones_territoriales_chubut WHERE id_pozo=?',id),followup:one(d.source,'SELECT * FROM seguimiento_inactivos WHERE id_pozo=?',id),image:one(d.source,'SELECT escena_id,fecha_adquisicion,resolucion_m,ancho_pixeles,alto_pixeles,nubosidad_recorte_pct,control_calidad FROM imagenes_iniciales_satelitales WHERE id_pozo=?',id),history:all(d.source,'SELECT fecha,tipo_evento,descripcion,fuente_url,calidad FROM historial WHERE id_pozo=? ORDER BY fecha DESC LIMIT 200',id),fractures:all(d.source,'SELECT fecha_inicio,fecha_fin,cantidad_fracturas,agua_inyectada_m3,arena_nacional_t,arena_importada_t,control_fechas,empresa_informante FROM fracturas_declaradas WHERE id_pozo=? ORDER BY fecha_inicio DESC LIMIT 100',id),area_history:all(d.source,'SELECT * FROM responsabilidades_areas WHERE area_inventario=? ORDER BY fecha_hecho DESC',record.area)};
  }
  function zones(params){
    const d=requireData(),{where,values}=industryFilter(params),groups=new Map();
    for(const r of all(d.index,`SELECT area,lon,lat FROM wells ${where}`,...values)){
      if(!r.area||!Number.isFinite(r.lon)||!Number.isFinite(r.lat))continue;
      if(!groups.has(r.area))groups.set(r.area,[]);groups.get(r.area).push([r.lon,r.lat]);
    }
    const features=[...groups].sort(([a],[b])=>a.localeCompare(b)).flatMap(([name,coords])=>{
      const ring=locationEnvelope(coords);return ring?[{type:'Feature',properties:{name,sector:'oil',wells:coords.length,boundary:'Contorno orientativo de ubicaciones; no es un límite de concesión'},geometry:{type:'Polygon',coordinates:[ring]}}]:[];
    });
    return {type:'FeatureCollection',features:mergeSectorZones(features)};
  }
  function sources(){const d=requireData();return {summary:all(d.source,'SELECT * FROM resumen_actualizacion'),sources:all(d.source,'SELECT * FROM vista_fuentes_chubut'),notes:all(d.source,'SELECT * FROM pendientes_documentales'),metadata:d.manifest.metadata,layers:all(d.source,'SELECT capa,COUNT(*) n FROM capas_territoriales_chubut GROUP BY capa')};}
  function layer(name){const d=requireData();if(!['spia_cuencas','urbanas','spia_aguas','localidades','rios'].includes(name))invalid('Capa no disponible.');return {type:'FeatureCollection',features:all(d.source,'SELECT gid,nombre,geometria_geojson,fuente_id FROM capas_territoriales_chubut WHERE capa=?',name).flatMap(r=>{try{const g=JSON.parse(r.geometria_geojson);return [{type:'Feature',geometry:g.type==='Feature'?g.geometry:g,properties:{id:r.gid,name:r.nombre,source:r.fuente_id,layer:name}}];}catch{return [];}})};}
  function image(id){const d=requireData(),r=one(d.source,'SELECT imagen_jpeg FROM imagenes_iniciales_satelitales WHERE id_pozo=?',id);if(!r)return null;const bytes=Buffer.from(r.imagen_jpeg);return bytes[0]===255&&bytes[1]===216&&bytes.length<2*1024*1024?bytes:null;}
  function report(params){
    const d=requireData(),s=summary('oil','AR',params),{where,values}=industryFilter(params);
    const grouped=column=>all(d.index,`SELECT COALESCE(NULLIF(${column},''),'Sin informar') label,COUNT(*) value FROM wells ${where} GROUP BY ${column} ORDER BY value DESC,label`,...values);
    return {title:'Inventario petrolero · Argentina / Chubut',generated_at:new Date().toISOString(),period:{label:'Actualización declarada: '+(s.prepared_at||'Sin informar')},scope:[params.get('company')||'Todas las empresas',params.get('area')||'Todas las áreas'].join(' · '),options:{companies:s.options.companies,areas:s.options.areas},
      notes:['Reporte del inventario aportado de Chubut; no representa todo el territorio argentino ni una serie en tiempo real. No se aplica un período móvil a este conjunto.','Seguimiento documental, imágenes y fracturas declaradas no acreditan daño ambiental, titularidad ni inspección actual. Se mantienen los alcances de la base aportada.'],
      metrics:[{label:'Pozos',value:s.totals.wells,hint:'Inventario de la selección'},{label:'Con seguimiento',value:s.totals.followup,hint:'Ficha documental'},{label:'Referencias satelitales',value:s.totals.images,hint:'Imágenes aportadas'},{label:'Con fractura declarada',value:s.totals.fractured,hint:'Pozos con antecedentes aportados'}],
      charts:[{title:'Estados declarados',rows:grouped('state')},{title:'Empresas informantes',rows:grouped('company')},{title:'Cuencas petroleras',rows:grouped('basin')},{title:'Áreas con más pozos',rows:grouped('area').slice(0,10)}],
      table:{columns:[['area','Área'],['wells','Pozos'],['followup','Con seguimiento'],['images','Con imagen'],['fractured','Con fractura declarada']],rows:all(d.index,`SELECT COALESCE(NULLIF(area,''),'Sin informar') area,COUNT(*) wells,SUM(followup) followup,SUM(has_image) images,SUM(has_fracture) fractured FROM wells ${where} GROUP BY area ORDER BY wells DESC,area`,...values)}};
  }
  function original(kind){const d=requireData(),file=d.manifest.files.find(f=>f.kind===kind);return file?{path:path.join(d.root,kind==='database'?'source.sqlite':'original-map.html'),name:file.name}:null;}
  return {catalog,summary,wells,map,zones,detail,sources,layer,image,original,report,close(){cache?.index.close();cache?.source.close();cache=null;}};
}
export function handleIndustry({store,actor,url,method,send,fail,res}){
  if(actor.role!=='superadmin'&&!actor.apps.includes(SATELLITE_APP))fail(403,'No tenés acceso a los paneles sectoriales de Reporte satelital.');
  if(method!=='GET')fail(405,'Los paneles sectoriales permiten consultar los datos aportados.');
  const route=url.pathname.slice('/api/industry/'.length),canDownloadOriginal=['superadmin','admin'].includes(actor.role);
  if(route==='catalog')return send(200,{...store.catalog(),canDownloadOriginal});
  const parts=route.split('/'),[sector,country,action,id,last]=parts;
  if(!sectors[sector]||country!=='AR')fail(404,'País o sector no disponible.');
  if(action==='summary'&&parts.length===3)return send(200,{...store.summary(sector,country,url.searchParams),canDownloadOriginal});
  if(sector!=='oil')fail(404,'Todavía no hay datos cargados para este sector.');
  if(action==='report'&&parts.length===3)return send(200,store.report(url.searchParams));
  if(action==='wells'&&!id)return send(200,store.wells(url.searchParams));
  if(action==='map'&&parts.length===3)return send(200,store.map(url.searchParams));
  if(action==='zones'&&parts.length===3)return send(200,store.zones(url.searchParams));
  if(action==='sources'&&parts.length===3)return send(200,store.sources());
  if(action==='layers'&&id&&parts.length===4)return send(200,store.layer(id));
  if(action==='wells'&&id){
    if(id.length>80)fail(400,'Identificador inválido.');
    if(last==='image'&&parts.length===5){const image=store.image(id);if(!image)fail(404,'El pozo no tiene una referencia satelital disponible.');res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'private, no-store'});return res.end(image);}
    if(parts.length===4){const detail=store.detail(id);if(!detail)fail(404,'Pozo no encontrado.');return send(200,detail);}
  }
  if(action==='files'&&parts.length===4){
    if(!canDownloadOriginal)fail(403,'Solo un administrador puede descargar los archivos originales.');
    if(!['database','map'].includes(id))fail(404,'Archivo no encontrado.');
    const file=store.original(id);if(!file)fail(404,'Archivo no disponible.');
    res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="AITUE-Chubut.${id==='database'?'sqlite':'html'}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,'Content-Length':statSync(file.path).size,'Cache-Control':'private, no-store','Content-Security-Policy':"sandbox; default-src 'none'"});
    const stream=createReadStream(file.path);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());return stream.pipe(res);
  }
  fail(404,'Consulta sectorial no encontrada.');
}
