const DAY=86400000;
const invalid=message=>{throw Object.assign(Error(message),{status:400});};
const types={vehicle:'Vehículo',aircraft:'Aeronave',person:'Persona',equipment:'Equipo',camera:'Cámara',other:'Otra unidad'};
const events={fire:'Incendios',storm:'Tormentas y ciclones',flood:'Inundaciones',earthquake:'Sismos',volcano:'Volcanes',drought:'Sequías',other:'Otros fenómenos'};
const levels={red:'Roja',orange:'Naranja',green:'Verde',unknown:'Sin clasificación'};
function option(params,key,values){const value=params.get(key)||'';if(value&&!values.includes(value))invalid('Filtro inválido: '+key+'.');return value;}
export function reportPeriod(params,maxDays,now=Date.now()){
  const raw=params.get('days')??'7',days=Number(raw);if(!/^\d+$/.test(raw)||!Number.isInteger(days)||days<1||days>maxDays)invalid('Período de reporte inválido.');
  return {days,from:new Date(now-days*DAY).toISOString(),to:new Date(now).toISOString()};
}
function daily(period,counts){const rows=[],end=period.to.slice(0,10);for(let day=period.from.slice(0,10);day<=end;day=new Date(Date.parse(day+'T00:00:00Z')+DAY).toISOString().slice(0,10))rows.push({label:day,value:counts.get(day)||0});return rows;}
const countBy=(rows,key)=>{const counts=new Map();for(const row of rows){const v=row[key]||'Sin informar';counts.set(v,(counts.get(v)||0)+1);}return [...counts].map(([label,value])=>({label,value})).sort((a,b)=>b.value-a.value||a.label.localeCompare(b.label));};
const metric=(label,value,hint)=>({label,value,hint});
export function buildSatelliteReport(data,params,now=Date.now()){
  const period=reportPeriod(params,7,now),category=option(params,'category',Object.keys(events)),source=option(params,'source',['eonet','gdacs','usgs']),level=option(params,'level',Object.keys(levels));
  const rows=data.events.filter(e=>e.time>=period.from&&e.time<=period.to&&(!category||e.category===category)&&(!source||e.source_id===source)&&(!level||e.level===level));
  const sources=data.sources.filter(s=>!source||s.id===source),byDay=new Map(countBy(rows.map(e=>({day:e.time.slice(0,10)})),'day').map(r=>[r.label,r.value]));
  return {title:'Eventos y alertas · Reporte satelital',generated_at:new Date(now).toISOString(),period,scope:[category?events[category]:'Todos los fenómenos',source||'Todas las fuentes',level?levels[level]:'Todos los niveles'].join(' · '),
    notes:['Registros del conjunto actual de las fuentes, filtrados por fecha del evento. Un fenómeno puede figurar en más de una fuente; no se cuentan sucesos únicos.','La consulta disponible cubre hasta 7 días. No hay un archivo histórico de consultas. Las fechas y los gráficos diarios usan UTC.','Sin clasificación no significa riesgo bajo; la ausencia de registros no confirma ausencia de peligro.'],sources,
    metrics:[metric('Registros en el período',rows.length,'Reportes de distintas fuentes'),metric('Nivel rojo publicado',rows.filter(e=>e.level==='red').length,'Según la clasificación de la fuente'),metric('Tipos de fenómeno',new Set(rows.map(e=>e.category)).size,'Tipos presentes en la selección'),metric('Fuentes disponibles',sources.filter(s=>s.status==='ok'||s.status==='stale').length,`${sources.length} seleccionadas · revisar su actualización`)],
    charts:[{title:'Reportes por fenómeno',rows:countBy(rows,'category').map(r=>({...r,label:events[r.label]||r.label}))},{title:'Reportes por nivel',rows:countBy(rows,'level').map(r=>({...r,label:levels[r.label]||r.label}))},{title:'Reportes por día · UTC',type:'timeline',rows:daily(period,byDay)},{title:'Reportes por fuente',rows:countBy(rows,'source')}],
    table:{columns:[['title','Reporte'],['category','Fenómeno'],['source','Fuente'],['level','Nivel publicado'],['time','Fecha del evento · UTC'],['country','País informado'],['source_status','Estado de la fuente']],rows:rows.sort((a,b)=>b.time.localeCompare(a.time)).map(e=>({title:e.title,category:events[e.category]||e.category,source:e.source,level:levels[e.level]||e.level,time:e.time,country:e.country||'Sin informar',source_status:({ok:'Disponible',stale:'Datos anteriores',unavailable:'No disponible'})[data.sources.find(s=>s.id===e.source_id)?.status]||'Sin información'}))}};
}
export function buildTrackingReport(db,params,now=Date.now()){
  const period=reportPeriod(params,30,now),kind=option(params,'kind',Object.keys(types)),status=option(params,'status',['active','archived']),source=option(params,'source',['manual','wialon','rinho']),unit=params.get('unit')||'';
  if(unit.length>80)invalid('Unidad inválida.');
  const allUnits=db.prepare('SELECT id,name FROM tracking_units ORDER BY name').all();if(unit&&!allUnits.some(u=>u.id===unit))invalid('Unidad no disponible.');
  const terms=[],values=[];if(kind){terms.push('u.kind=?');values.push(kind);}if(status){terms.push('u.active=?');values.push(status==='active'?1:0);}if(unit){terms.push('u.id=?');values.push(unit);}const where=terms.length?'WHERE '+terms.join(' AND '):'';
  const periodTerms='p.recorded_at>=? AND p.recorded_at<=?'+(source?' AND p.source=?':''),periodValues=[period.from,period.to,...(source?[source]:[])];
  const rows=db.prepare(`SELECT u.id,u.name,u.identifier,u.kind,u.active,COUNT(p.id) samples,
    SUM(CASE WHEN p.source='manual' THEN 1 ELSE 0 END) manual,SUM(CASE WHEN p.source='wialon' THEN 1 ELSE 0 END) wialon,SUM(CASE WHEN p.source='rinho' THEN 1 ELSE 0 END) rinho,
    MIN(p.recorded_at) first_at,MAX(p.recorded_at) last_at,MAX(p.speed) max_speed
    FROM tracking_units u LEFT JOIN tracking_positions p ON p.unit_id=u.id AND ${periodTerms} ${where} GROUP BY u.id ORDER BY samples DESC,u.name,u.id`).all(...periodValues,...values);
  const days=db.prepare(`SELECT substr(p.recorded_at,1,10) day,COUNT(*) n FROM tracking_positions p JOIN tracking_units u ON u.id=p.unit_id ${where?where+' AND ':'WHERE '}${periodTerms} GROUP BY day ORDER BY day`).all(...values,...periodValues);
  const deviceCount=db.prepare(`SELECT COUNT(*) n FROM tracking_devices d JOIN tracking_units u ON u.id=d.unit_id ${where}`).get(...values).n;
  const cameraCount=db.prepare(`SELECT COUNT(*) n FROM tracking_cameras c JOIN tracking_devices d ON d.id=c.device_id JOIN tracking_units u ON u.id=d.unit_id ${where}`).get(...values).n;
  const sums={manual:0,wialon:0,rinho:0};for(const r of rows)for(const k of Object.keys(sums))sums[k]+=r[k];
  return {title:'Actividad de unidades · Trackeo',generated_at:new Date(now).toISOString(),period,scope:[unit?allUnits.find(u=>u.id===unit).name:'Todas las unidades',kind?types[kind]:'Todos los tipos',status==='active'?'Habilitadas':status==='archived'?'Archivadas':'Todos los estados',source||'Todas las fuentes'].join(' · '),options:{units:allUnits},
    notes:['Las posiciones se cuentan por fecha de la muestra, dentro de un intervalo móvil. Los gráficos diarios usan UTC; el primer y último día pueden ser parciales.','Las posiciones manuales se distinguen de la telemetría. Una unidad sin muestras en el período no significa que esté desconectada.','GPS y cámaras son inventario actual de las unidades seleccionadas; no prueban conexión ni reproducción. No se calculan distancia, horas de uso o grabaciones a partir de datos incompletos.'],
    metrics:[metric('Unidades en la selección',rows.length,'Inventario actual, incluidos los estados elegidos'),metric('Unidades con posiciones',rows.filter(r=>r.samples>0).length,'Con al menos una muestra en el período'),metric('Posiciones registradas',rows.reduce((sum,r)=>sum+r.samples,0),'Muestras del período y fuente elegidos'),metric('GPS / cámaras vinculadas',`${deviceCount} / ${cameraCount}`,'Inventario actual de la selección')],
    charts:[{title:'Unidades por tipo · inventario',rows:countBy(rows,'kind').map(r=>({...r,label:types[r.label]||r.label}))},{title:'Posiciones por fuente',rows:Object.entries(sums).map(([label,value])=>({label:label==='manual'?'Manual':label==='rinho'?'Rinho directo':'Wialon',value}))},{title:'Posiciones por día · UTC',type:'timeline',rows:daily(period,new Map(days.map(r=>[r.day,r.n])))},{title:'Unidades con más muestras',rows:rows.filter(r=>r.samples>0).slice(0,10).map(r=>({label:r.name,value:r.samples}))}],
    table:{columns:[['name','Unidad'],['identifier','Identificador'],['kind','Tipo'],['status','Estado actual'],['samples','Posiciones'],['manual','Manuales'],['wialon','Wialon'],['rinho','Rinho directo'],['first_at','Primera muestra · UTC'],['last_at','Última muestra · UTC'],['max_speed','Velocidad máx. recibida · km/h']],rows:rows.map(r=>({...r,kind:types[r.kind]||r.kind,status:r.active?'Habilitada':'Archivada'}))}};
}
