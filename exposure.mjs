import { satelliteService, SATELLITE_APP, categories } from './satellite.mjs';
import { TRACKING_APP } from './tracking.mjs';
import { trackingScope, trackingIdentity } from './tracking-access.mjs';
import { mapAreaCopies } from './public/satellite-geometry.js';

const DAY=86400000;
export function distanceKm(a,b){
  const rad=v=>v*Math.PI/180;
  const h=Math.sin(rad(b.lat-a.lat)/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(rad(b.lon-a.lon)/2)**2;
  return 12742*Math.asin(Math.min(1,Math.sqrt(h)));
}
// 0 exterior, 1 interior, 2 borde. Los huecos excluyen su interior, no su borde.
function inRing(x,y,ring){
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const [ax,ay]=ring[j],[bx,by]=ring[i];
    if(Math.abs((x-ax)*(by-ay)-(y-ay)*(bx-ax))<1e-10&&x>=Math.min(ax,bx)-1e-10&&x<=Math.max(ax,bx)+1e-10&&y>=Math.min(ay,by)-1e-10&&y<=Math.max(ay,by)+1e-10)return 2;
    if((ay>y)!==(by>y)&&x<(bx-ax)*(y-ay)/(by-ay)+ax)inside=!inside;
  }
  return inside?1:0;
}
export function inPublishedArea(position,polygons){
  return polygons.some(p=>{
    const outer=inRing(position.lon,position.lat,p.coordinates[0]);if(!outer)return false;if(outer===2)return true;
    for(const ring of p.coordinates.slice(1)){const hole=inRing(position.lon,position.lat,ring);if(hole===2)return true;if(hole===1)return false;}return true;
  });
}
export function exposureOptions(params){
  const bad=message=>{throw Object.assign(Error(message),{status:400});};
  const number=(key,initial,min,max)=>{const raw=params.get(key),n=raw===null?initial:Number(raw);if(raw!==null&&!raw.trim()||!Number.isFinite(n)||n<min||n>max)bad('Parámetros de cruce inválidos.');return n;};
  const category=params.get('category')||'',source=params.get('source')||'',quality=params.get('quality')||'',relation=params.get('relation')||'';
  if(category&&!Object.hasOwn(categories,category)||source&&!['gdacs','eonet','usgs'].includes(source)||quality&&!['recent','stale','manual'].includes(quality)||relation&&!['area','reference'].includes(relation))bad('Filtro de cruce inválido.');
  return {radius_km:number('radius',25,1,500),fresh_minutes:number('fresh',30,1,1440),category,source,quality,relation,unit:params.get('unit')||''};
}
export function buildExposure(units,snapshot,options,now=Date.now()){
  const events=(snapshot.events||[]).filter(e=>Number.isFinite(e.lat)&&Number.isFinite(e.lon)&&Date.parse(e.time)<=now&&Date.parse(e.time)>=now-7*DAY&&(!options.category||e.category===options.category)&&(!options.source||e.source_id===options.source)).map(e=>({event:e,polygons:(e.area?.features||[]).flatMap(f=>mapAreaCopies(f.geometry))}));
  const sources=new Map((snapshot.sources||[]).map(s=>[s.id,s]));
  const rows=[],unitIds=new Set(),eventIds=new Set();let total=0,area=0,reference=0,review=0,missing=0;
  for(const u of units){
    const age=now-Date.parse(u.recorded_at);
    if(!Number.isFinite(u.lat)||!Number.isFinite(u.lon)||!Number.isFinite(age)||age<0){missing++;continue;}
    const quality=u.source==='manual'?'manual':age<=options.fresh_minutes*60000?'recent':'stale';
    if(options.quality&&options.quality!==quality)continue;
    for(const {event:e,polygons} of events){
      const distance=distanceKm(u,e),relation=polygons.length?(inPublishedArea(u,polygons)?'area':null):(distance<=options.radius_km?'reference':null);
      if(!relation||options.relation&&options.relation!==relation)continue;
      const source=sources.get(e.source_id),needsReview=quality!=='recent'||source?.status!=='ok'||e.area_status==='stale';
      total++;if(relation==='area')area++;else reference++;if(needsReview)review++;unitIds.add(u.id);eventIds.add(e.id);
      if(rows.length<2000)rows.push({unit:{id:u.id,name:u.name,internal_number:u.internal_number,kind:u.kind,lat:u.lat,lon:u.lon,recorded_at:u.recorded_at,source:u.source},event:{id:e.id,title:e.title,category:e.category,level:e.level,lat:e.lat,lon:e.lon,time:e.time,updated:e.updated,source:e.source,source_id:e.source_id,url:e.url,area_status:e.area_status||'not_published'},relation,quality,needs_review:needsReview,distance_km:Math.round(distance*100)/100,source_status:source?.status||'unavailable',fetched_at:source?.fetched_at||null});
    }
  }
  const ids=new Set(rows.map(r=>r.event.id));
  return {checked_at:new Date(now).toISOString(),window_days:7,options,sources:snapshot.sources||[],partial:!!snapshot.partial||(snapshot.sources||[]).some(s=>s.status!=='ok'),summary:{units:units.length,missing_position:missing,matched_units:unitIds.size,events:eventIds.size,matches:total,area,reference,review},rows,truncated:total>rows.length,limit:2000,areas:events.filter(({event,polygons})=>ids.has(event.id)&&polygons.length).map(({event})=>({id:event.id,geometry:event.area}))};
}
export async function handleExposure({db,actor,url,method,send,fail,service=satelliteService,currentActor=()=>actor,now=Date.now}){
  const authorize=a=>{if(!a||a.active===false)fail(401,'La sesión ya no está disponible.');if(a.role!=='superadmin'&&![TRACKING_APP,SATELLITE_APP].every(id=>a.apps.includes(id)))fail(403,'Necesitás acceso a Trackeo y Reporte satelital para consultar este cruce.');};
  authorize(actor);if(method!=='GET')fail(405,'El cruce permite consultas.');
  const options=exposureOptions(url.searchParams);
  const getUnits=a=>{const scope=trackingScope(a);return db.prepare(`SELECT u.id,u.name,u.identifier,u.internal_number,u.kind,p.lat,p.lon,p.recorded_at,p.source FROM tracking_units u LEFT JOIN tracking_positions p ON p.id=(SELECT p2.id FROM tracking_positions p2 WHERE p2.unit_id=u.id AND p2.recorded_at<=? AND (p2.source='manual' OR EXISTS(SELECT 1 FROM tracking_devices d WHERE d.id=p2.device_id AND d.unit_id=u.id)) ORDER BY p2.recorded_at DESC,p2.id DESC LIMIT 1) WHERE u.active=1 AND ${scope.sql} ORDER BY u.internal_number`).all(new Date(now()).toISOString(),...scope.values).map(u=>trackingIdentity(u,a));};
  let units=getUnits(actor);if(options.unit&&!units.some(u=>u.id===options.unit))fail(404,'Unidad no encontrada en tu alcance.');
  if(url.pathname==='/api/exposure/access')return send(200,{ids:units.map(u=>u.id)});
  // Sin unidades no se consulta a los proveedores externos.
  const snapshot=units.length?await service.events():{events:[],sources:[],partial:false};
  actor=currentActor();authorize(actor);units=getUnits(actor);
  if(options.unit&&!units.some(u=>u.id===options.unit))fail(404,'Unidad no encontrada en tu alcance.');
  const result=buildExposure(options.unit?units.filter(u=>u.id===options.unit):units,snapshot,options,now());
  return send(200,{...result,units:units.map(({id,name,internal_number})=>({id,name,internal_number}))});
}
