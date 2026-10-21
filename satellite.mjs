import { areaGeometry, areaCenter } from './public/satellite-geometry.js';
import { buildSatelliteReport, reportPeriod } from './reports.mjs';
export const SATELLITE_APP='aitue-reporte-satelital';
const MINUTE=60000;
const identity='AITUECentral/0.1 (+https://github.com/Ukinaut/App-Aitue-Center)';
export const categories={fire:'Incendios',storm:'Tormentas y ciclones',flood:'Inundaciones',earthquake:'Sismos',volcano:'Volcanes',drought:'Sequías',other:'Otros fenómenos'};
export function initializeSatellite(db){
  db.prepare('INSERT OR IGNORE INTO apps VALUES (?,?,?,?,?)').run(SATELLITE_APP,'Reporte satelital','Monitoreo mundial de clima, vientos, incendios, catástrofes y alertas.','/?app=reporte-satelital','teal');
}
const safeUrl=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}};
const instant=value=>{const n=typeof value==='number'?value:Date.parse(value?.match(/Z$|[+-]\d\d:\d\d$/)?value:value+'Z');return Number.isFinite(n)?new Date(n).toISOString():null;};
const point=geometry=>geometry?.type==='Point'&&Array.isArray(geometry.coordinates)&&geometry.coordinates.length>=2&&geometry.coordinates.slice(0,2).every(Number.isFinite)&&Math.abs(geometry.coordinates[0])<=180&&Math.abs(geometry.coordinates[1])<=90?{lat:geometry.coordinates[1],lon:geometry.coordinates[0]}:null;
const level=value=>['green','orange','red'].includes(String(value).toLowerCase())?String(value).toLowerCase():'unknown';
const clean=value=>String(value??'').replace(/<[^>]*>/g,'').slice(0,1000);
export function normalizeEvents(source,data){
  if(source==='eonet'){
    if(!Array.isArray(data.events))throw Error('Formato EONET inválido.');
    return data.events.flatMap(e=>{
      const g=[...(e.geometry||[])].filter(g=>(point(g)||areaCenter(g))&&instant(g.date)).sort((a,b)=>Date.parse(b.date)-Date.parse(a.date))[0];if(!g)return [];
      const category=({wildfires:'fire',severeStorms:'storm',floods:'flood',earthquakes:'earthquake',volcanoes:'volcano',drought:'drought'})[e.categories?.[0]?.id]||'other';
      return [{id:'eonet:'+e.id,title:clean(e.title),description:clean(e.description),category,level:'unknown',source:'NASA EONET',source_id:source,time:instant(g.date),updated:instant(g.date),status:e.closed?'Cerrado por la fuente':'Abierto en EONET',...(point(g)||areaCenter(g)),area:areaGeometry(g)?{type:'FeatureCollection',features:[{type:'Feature',geometry:areaGeometry(g),properties:{label:'Área publicada por NASA EONET',time:instant(g.date)}}]}:null,area_status:areaGeometry(g)?'provided':'not_published',url:safeUrl(e.sources?.find(s=>safeUrl(s.url))?.url)||safeUrl(e.link),magnitude:Number.isFinite(g.magnitudeValue)?`${g.magnitudeValue} ${clean(g.magnitudeUnit)}`:null}];
    });
  }
  if(!Array.isArray(data.features))throw Error('Formato GeoJSON inválido.');
  const seen=new Set();
  return data.features.flatMap(f=>{
    const p=f.properties||{},position=point(f.geometry);if(!position)return [];
    if(source==='gdacs'){
      const id=`gdacs:${p.eventtype}:${p.eventid}`;if(seen.has(id))return [];seen.add(id);
      const time=instant(p.todate||p.fromdate);if(!time)return [];
      return [{id,title:clean(p.name||p.eventname),description:clean(p.severitydata?.severitytext||p.description),category:({WF:'fire',TC:'storm',FL:'flood',EQ:'earthquake',VO:'volcano',DR:'drought'})[p.eventtype]||'other',level:level(p.alertlevel),source:'GDACS',source_id:source,time,updated:instant(p.datemodified)||time,status:'Reporte GDACS',country:clean(p.country),geometry_ref:{event_type:clean(p.eventtype),event_id:p.eventid,episode_id:p.episodeid},...position,url:safeUrl(p.url?.report),magnitude:null}];
    }
    const time=instant(p.time);if(!time)return [];
    return [{id:'usgs:'+f.id,title:clean(p.title||p.place),description:`${clean(p.place)}${Number.isFinite(f.geometry.coordinates[2])?' · Profundidad: '+f.geometry.coordinates[2]+' km':''}${p.tsunami?' · USGS indica un evento con información de tsunami; consultar el reporte.':''}`,category:'earthquake',level:level(p.alert),source:'USGS',source_id:source,time,updated:instant(p.updated)||time,status:p.status==='reviewed'?'Revisado por USGS':'Registro automático',...position,url:safeUrl(p.url),magnitude:Number.isFinite(p.mag)?`M ${p.mag}`:null}];
  });
}
export function normalizeGdacsAreas(data,event){
  const candidates=(Array.isArray(data.features)?data.features:[]).filter(f=>areaGeometry(f.geometry));
  const allWind=candidates.filter(f=>f.properties?.featuretype==='WindRadii');
  // WindRadii usa una hora de validez; en otras áreas polygondate es la hora de generación.
  const wind=allWind.filter(f=>!f.properties?.polygondate||Date.parse(instant(f.properties.polygondate))<=Date.parse(event.time));
  let selected=allWind.length?wind:candidates;
  const dates=selected.map(f=>instant(f.properties?.polygondate)).filter(Boolean).sort();
  if(dates.length)selected=selected.filter(f=>!f.properties?.polygondate||instant(f.properties.polygondate)===dates.at(-1));
  return {type:'FeatureCollection',features:selected.slice(0,80).map(f=>({type:'Feature',geometry:areaGeometry(f.geometry),properties:{label:clean((wind.length?'Área modelada de viento · ':'')+(f.properties?.polygonlabel||'Área publicada por GDACS')),time:instant(f.properties?.polygondate)||event.time}}))};
}
export function normalizeWeather(data,now=Date.now()){
  const rows=data.properties?.timeseries;if(!Array.isArray(rows)||!rows.length)throw Error('Sin pronóstico disponible.');
  const parse=row=>{const d=row.data?.instant?.details||{},next=row.data?.next_1_hours||row.data?.next_6_hours;
    const numeric=v=>Number.isFinite(v)?v:null;
    return {time:instant(row.time),temperature:numeric(d.air_temperature),humidity:numeric(d.relative_humidity),pressure:numeric(d.air_pressure_at_sea_level),cloud:numeric(d.cloud_area_fraction),wind:Number.isFinite(d.wind_speed)?Math.round(d.wind_speed*36)/10:null,direction:numeric(d.wind_from_direction),gust:Number.isFinite(d.wind_speed_of_gust)?Math.round(d.wind_speed_of_gust*36)/10:null,precipitation:numeric(next?.details?.precipitation_amount),precipitation_hours:row.data?.next_1_hours?1:6,symbol:clean(next?.summary?.symbol_code)};};
  const index=Math.max(0,rows.findLastIndex(row=>Date.parse(row.time)<=now));
  const current=parse(rows[index]);if(!Number.isFinite(current.temperature))throw Error('Temperatura no disponible.');
  return {model_updated:instant(data.properties.meta?.updated_at),current,hourly:rows.slice(index,index+24).map(parse),source:'MET Norway',url:'https://api.met.no/',license:'https://creativecommons.org/licenses/by/4.0/'};
}
export function createSatelliteService({fetcher=fetch,now=Date.now}={}){
  const cache=new Map(),flights=new Map();let geoQueue=Promise.resolve(),geoLast=0;
  async function read(url,ttl=5*MINUTE){
    const key=url.toString(),previous=cache.get(key),at=now();
    if(previous?.until>at)return {...previous.result,status:'ok'};
    if(previous?.retry>at)return previous.result?.data&&at-Date.parse(previous.result.fetched_at)<24*60*MINUTE?{...previous.result,status:'stale'}:{status:'unavailable',data:null,fetched_at:null};
    if(flights.has(key))return flights.get(key);
    const pending=(async()=>{
      try{
        if(url.hostname==='nominatim.openstreetmap.org'){
          const turn=geoQueue;let release;geoQueue=new Promise(resolve=>release=resolve);await turn;
          try{const pause=Math.max(0,1100-(now()-geoLast));if(pause)await new Promise(resolve=>setTimeout(resolve,pause));geoLast=now();}finally{release();}
        }
        const response=await fetcher(key,{headers:{'User-Agent':identity,Accept:'application/json',...(previous?.modified?{'If-Modified-Since':previous.modified}:{})},signal:AbortSignal.timeout(12000),redirect:'error'});
        if(response.status===304&&previous?.result){previous.until=now()+ttl;previous.result.fetched_at=new Date(now()).toISOString();return {...previous.result,status:'ok'};}
        if(!response.ok)throw Error('Fuente no disponible.');
        const reader=response.body.getReader();let size=0;const chunks=[];
        while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>5*1024*1024){await reader.cancel();throw Error('Respuesta demasiado grande.');}chunks.push(value);}
        const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result={data,fetched_at:new Date(now()).toISOString(),status:'ok'};
        const expires=Date.parse(response.headers.get('expires'))||0;
        cache.set(key,{result,until:Math.max(now()+ttl,Math.min(expires,now()+24*60*MINUTE)),modified:response.headers.get('last-modified')});
        return result;
      }catch{
        cache.set(key,{...previous,retry:now()+MINUTE});
        return previous?.result?.data&&now()-Date.parse(previous.result.fetched_at)<24*60*MINUTE?{...previous.result,status:'stale'}:{data:null,fetched_at:null,status:'unavailable'};
      }finally{flights.delete(key);if(cache.size>256)cache.delete(cache.keys().next().value);}
    })();flights.set(key,pending);return pending;
  }
  async function events({includeAreas=true}={}){
    const end=new Date(now()+86400000).toISOString().slice(0,10),start=new Date(now()-7*86400000).toISOString().slice(0,10);
    const feeds=[{id:'gdacs',name:'GDACS',url:`https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=EQ;TC;FL;VO;DR;WF&fromdate=${start}&todate=${end}&pagesize=1000`,home:'https://www.gdacs.org/'},{id:'eonet',name:'NASA EONET',url:'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=7&limit=200',home:'https://eonet.gsfc.nasa.gov/'},{id:'usgs',name:'USGS',url:'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson',home:'https://earthquake.usgs.gov/'}];
    const sources=await Promise.all(feeds.map(async feed=>{
      const result=await read(new URL(feed.url));let reports=[];
      if(result.data)try{reports=normalizeEvents(feed.id,result.data);}catch{result.status='unavailable';}
      return {id:feed.id,name:feed.name,url:feed.home,status:result.status,fetched_at:result.fetched_at,reports};
    }));
    const reports=sources.flatMap(s=>s.reports).sort((a,b)=>Date.parse(b.updated)-Date.parse(a.updated));
    // Solo URLs construidas con claves numéricas de GDACS; no se aceptan URLs del cliente.
    const pending=reports.filter(e=>e.source_id==='gdacs');
    async function areasWorker(){while(pending.length){const event=pending.shift(),ref=event.geometry_ref;
      event.area=null;event.area_status='not_published';
      if(!ref||!['EQ','TC','FL','VO','DR','WF'].includes(ref.event_type)||!/^\d+$/.test(String(ref.event_id))||!/^\d+$/.test(String(ref.episode_id)))continue;
      const url=new URL('https://www.gdacs.org/gdacsapi/api/polygons/getgeometry');url.search=new URLSearchParams({eventtype:ref.event_type,eventid:String(ref.event_id),episodeid:String(ref.episode_id)});
      const result=await read(url,15*MINUTE);event.area_fetched_at=result.fetched_at;
      if(!result.data){event.area_status='unavailable';continue;}
      const area=normalizeGdacsAreas(result.data,event);
      if(area.features.length){event.area=area;event.area_status=result.status==='stale'?'stale':'provided';}
    }}
    if(includeAreas)await Promise.all([areasWorker(),areasWorker(),areasWorker()]);
    return {events:reports,sources:sources.map(({reports,...source})=>({...source,count:reports.length})),categories,window_days:7,checked_at:new Date(now()).toISOString(),refresh_seconds:300,partial:sources.some(s=>s.status!=='ok')};
  }
  async function weather(lat,lon){
    const result=await read(new URL(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`),10*MINUTE);
    if(!result.data)return {status:'unavailable',fetched_at:null};
    try{return {...normalizeWeather(result.data,now()),lat,lon,status:result.status,fetched_at:result.fetched_at};}catch{return {status:'unavailable',fetched_at:result.fetched_at};}
  }
  async function search(q){
    const url=new URL('https://nominatim.openstreetmap.org/search');url.search=new URLSearchParams({q,format:'jsonv2',limit:'5','accept-language':'es'});
    const result=await read(url,60*MINUTE);
    return {status:result.status,results:Array.isArray(result.data)?result.data.filter(r=>Number.isFinite(Number(r.lat))&&Number.isFinite(Number(r.lon))).map(r=>({name:clean(r.display_name),lat:Number(r.lat),lon:Number(r.lon)})):[]};
  }
  return {events,weather,search};
}
export const satelliteService=createSatelliteService();
export async function handleSatellite({actor,url,method,send,fail,service=satelliteService}){
  if(actor.role!=='superadmin'&&!actor.apps.includes(SATELLITE_APP))fail(403,'No tenés acceso a Reporte satelital.');
  if(method!=='GET')fail(405,'Esta aplicación permite consultar información.');
  const route=url.pathname.slice('/api/satellite/'.length);
  if(route==='report'){reportPeriod(url.searchParams,7);return send(200,buildSatelliteReport(await service.events({includeAreas:false}),url.searchParams));}
  if(route==='events')return send(200,await service.events());
  if(route==='weather'){
    const coordinate=(name,max)=>{const value=url.searchParams.get(name);if(value===null||!value.trim()||!Number.isFinite(Number(value))||Math.abs(Number(value))>max)fail(400,'Coordenadas inválidas.');return Number(Number(value).toFixed(2));};
    const lat=coordinate('lat',90),lon=coordinate('lon',180),result=await service.weather(lat,lon);
    if(result.status==='unavailable')fail(503,'No se pudo consultar el clima. Volvé a intentarlo.');
    return send(200,result);
  }
  if(route==='search'){
    const q=(url.searchParams.get('q')||'').trim();if(q.length<3||q.length>120)fail(400,'Ingresá entre 3 y 120 caracteres para buscar una ubicación.');
    const result=await service.search(q);if(result.status==='unavailable')fail(503,'El buscador no está disponible. Podés seleccionar un punto en el mapa.');return send(200,result);
  }
  fail(404,'Consulta de Reporte satelital no encontrada.');
}
