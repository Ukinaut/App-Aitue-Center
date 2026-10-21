import { randomUUID, randomBytes } from 'node:crypto';
import { hashPassword } from './auth.mjs';
import { buildTrackingReport } from './reports.mjs';
import { createWialonClient } from './tracking-wialon.mjs';
import { trackingScope, trackingIdentity, nextTrackingNumber } from './tracking-access.mjs';
const wialon=createWialonClient();

export const TRACKING_APP='aitue-trackeo-video';
export function initializeTracking(db){
  db.exec(`CREATE TABLE IF NOT EXISTS tracking_units (
    id TEXT PRIMARY KEY,name TEXT NOT NULL,identifier TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tracking_positions (
    id INTEGER PRIMARY KEY,unit_id TEXT NOT NULL REFERENCES tracking_units(id),
    lat REAL NOT NULL,lon REAL NOT NULL,source TEXT NOT NULL,recorded_at TEXT NOT NULL,
    actor_id TEXT NOT NULL REFERENCES users(id));
    CREATE INDEX IF NOT EXISTS tracking_positions_unit ON tracking_positions(unit_id,id DESC);`);
  const columns=new Set(db.prepare('PRAGMA table_info(tracking_positions)').all().map(r=>r.name));
  for(const [name,type] of [['device_id','TEXT'],['speed','REAL'],['altitude','REAL'],['heading','REAL']])if(!columns.has(name))db.exec(`ALTER TABLE tracking_positions ADD COLUMN ${name} ${type}`);
  db.exec(`CREATE TABLE IF NOT EXISTS tracking_devices (
    id TEXT PRIMARY KEY,unit_id TEXT REFERENCES tracking_units(id),name TEXT NOT NULL,
    imei TEXT UNIQUE,psn TEXT UNIQUE,manufacturer TEXT NOT NULL DEFAULT '',model TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT 'manual',external_id TEXT,created_at TEXT NOT NULL,UNIQUE(provider,external_id));
    CREATE TABLE IF NOT EXISTS tracking_cameras (
    id TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES tracking_devices(id),name TEXT NOT NULL,
    channel TEXT NOT NULL,format TEXT NOT NULL,url TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,UNIQUE(device_id,channel));
    CREATE INDEX IF NOT EXISTS tracking_positions_time ON tracking_positions(unit_id,recorded_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS tracking_positions_recorded ON tracking_positions(recorded_at,unit_id);
    CREATE INDEX IF NOT EXISTS tracking_devices_unit ON tracking_devices(unit_id);`);
  const deviceColumns=new Set(db.prepare('PRAGMA table_info(tracking_devices)').all().map(r=>r.name));
  for(const name of ['ingest_hash','ingest_actor_id'])if(!deviceColumns.has(name))db.exec(`ALTER TABLE tracking_devices ADD COLUMN ${name} TEXT`);
  db.exec('BEGIN IMMEDIATE');
  try{
    if(!db.prepare('PRAGMA table_info(tracking_units)').all().some(c=>c.name==='internal_number'))db.exec('ALTER TABLE tracking_units ADD COLUMN internal_number TEXT');
    for(const u of db.prepare('SELECT id FROM tracking_units WHERE internal_number IS NULL ORDER BY rowid').all())db.prepare('UPDATE tracking_units SET internal_number=? WHERE id=?').run(nextTrackingNumber(db),u.id);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS tracking_internal_number ON tracking_units(internal_number COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS tracking_unit_access(unit_id TEXT NOT NULL REFERENCES tracking_units(id),user_id TEXT NOT NULL REFERENCES users(id),PRIMARY KEY(unit_id,user_id));
      CREATE INDEX IF NOT EXISTS tracking_access_user ON tracking_unit_access(user_id,unit_id);`);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  db.prepare('INSERT OR IGNORE INTO apps VALUES (?,?,?,?,?)').run(TRACKING_APP,'Trackeo / Streaming de video','Seguimiento de unidades, ubicaciones y centro de video.','/?app=trackeo-video','teal');
}
export function handleTracking({db,actor,users=[],url,method,b,send,fail,transaction,log,service=wialon,receiver={status:{enabled:false,ready:false,port:5101,protocol:'Wialon IPS 1.x / TCP'}}}){
  if(actor.role!=='superadmin'&&!actor.apps.includes(TRACKING_APP))fail(403,'No tenés acceso a Trackeo / Streaming de video.');
  const manager=['superadmin','admin'].includes(actor.role),route=url.pathname.slice('/api/tracking/'.length);
  const scope=trackingScope(actor);
  const visible=id=>!!db.prepare(`SELECT u.id FROM tracking_units u WHERE u.id=? AND ${scope.sql}`).get(id,...scope.values);
  const assignees=manager?users.filter(u=>u.active&&['controlador','usuario'].includes(u.role)&&u.apps.includes(TRACKING_APP)).map(({id,name,role})=>({id,name,role})):[];
  const assignments=ids=>{
    if(!Array.isArray(ids)||ids.length>500||ids.some(id=>typeof id!=='string'||!assignees.some(u=>u.id===id)))fail(400,'Seleccioná controladores o usuarios finales activos con acceso a Trackeo.');
    return [...new Set(ids)];
  };
  const saveAccess=(id,ids)=>{db.prepare('DELETE FROM tracking_unit_access WHERE unit_id=?').run(id);for(const userId of ids)db.prepare('INSERT INTO tracking_unit_access VALUES (?,?)').run(id,userId);};
  const internalNumber=(old=null)=>{
    const value=b.internal_number===undefined?(old?.internal_number||nextTrackingNumber(db)):b.internal_number;
    if(typeof value!=='string'||!/^[a-z0-9][a-z0-9._/-]{0,39}$/i.test(value.trim()))fail(400,'El número interno admite hasta 40 letras, números, puntos, guiones, barras o guiones bajos.');
    const number=value.trim();
    if(db.prepare('SELECT id FROM tracking_units WHERE internal_number=? COLLATE NOCASE AND id<>?').get(number,old?.id||''))fail(409,'Ese número interno ya está registrado.');
    return number;
  };
  if(route==='report'&&method==='GET')return send(200,buildTrackingReport(db,url.searchParams,Date.now(),actor));
  const units=()=>db.prepare(`SELECT u.*,p.lat,p.lon,p.source,p.recorded_at,p.speed,p.altitude,p.heading,p.device_id FROM tracking_units u
    LEFT JOIN tracking_positions p ON p.id=(SELECT id FROM tracking_positions WHERE unit_id=u.id ORDER BY recorded_at DESC,id DESC LIMIT 1)
    WHERE ${scope.sql} ORDER BY u.active DESC,u.name,u.id`).all(...scope.values);
  if(route==='dashboard'&&method==='GET'){
    const unitRows=units().map(u=>({...trackingIdentity(u,actor),...(manager?{assigned_users:db.prepare('SELECT user_id FROM tracking_unit_access WHERE unit_id=? ORDER BY user_id').all(u.id).map(a=>({id:a.user_id,name:users.find(x=>x.id===a.user_id)?.name||'Cuenta no disponible',role:users.find(x=>x.id===a.user_id)?.role||'',eligible:assignees.some(x=>x.id===a.user_id)}))}:{})}));
    const ids=new Set(unitRows.map(u=>u.id));
    const deviceRows=db.prepare('SELECT id,unit_id,name,imei,psn,manufacturer,model,provider,external_id,created_at,CASE WHEN ingest_hash IS NULL THEN 0 ELSE 1 END ingest_configured FROM tracking_devices ORDER BY name,id').all().filter(d=>manager||ids.has(d.unit_id)).map(d=>manager?d:{id:d.id,unit_id:d.unit_id,name:'GPS · '+unitRows.find(u=>u.id===d.unit_id).internal_number,created_at:d.created_at});
    const deviceIds=new Set(deviceRows.map(d=>d.id));
    const cameraRows=db.prepare('SELECT * FROM tracking_cameras ORDER BY device_id,created_at,id').all().filter(c=>manager||deviceIds.has(c.device_id)).map((c,i)=>manager?{...c,has_source:!!c.url}:{id:c.id,device_id:c.device_id,name:'Cámara '+(i+1),channel:String(i+1),format:c.format,has_source:!!c.url});
    return send(200,{units:unitRows,devices:deviceRows,cameras:cameraRows,assignees,canManage:manager,gpsConnected:false,videoConnected:false,integrations:manager?{wialon:{configured:service.configured()},rinho:{configured:receiver.status.ready,status:'ips_receiver',receiver:receiver.status,public_host:process.env.TRACKING_PUBLIC_HOST||''}}:null});
  }
  const playback=route.match(/^cameras\/([a-z0-9-]+)\/playback$/i);
  if(playback&&method==='GET'){
    const c=db.prepare('SELECT c.*,d.unit_id,d.imei,d.psn,d.external_id FROM tracking_cameras c JOIN tracking_devices d ON d.id=c.device_id WHERE c.id=?').get(playback[1]);
    if(!c||!manager&&!visible(c.unit_id))fail(404,'Cámara no encontrada en tu alcance.');
    if(!c.url)fail(409,'La cámara todavía no tiene fuente configurada.');
    // El navegador reproduce directamente. No entregar URLs con identidades reales incrustadas.
    if(!manager){const u=db.prepare('SELECT identifier FROM tracking_units WHERE id=?').get(c.unit_id);let decoded=c.url;try{decoded=decodeURIComponent(c.url);}catch{}
      if([c.imei,c.psn,c.external_id,u.identifier].filter(v=>v&&v.length>=4).some(v=>decoded.toLowerCase().includes(v.toLowerCase())))fail(409,'Un administrador debe configurar un enlace de video sin identificadores reales del equipo.');}
    return send(200,{url:c.url,format:c.format});
  }
  const history=route.match(/^units\/([a-z0-9-]+)\/history$/i);
  if(history&&method==='GET'){
    if(!visible(history[1]))fail(404,'Unidad no encontrada en tu alcance.');
    const hours=Number(url.searchParams.get('hours')||24);if(!Number.isInteger(hours)||hours<1||hours>168)fail(400,'Intervalo inválido.');
    const rows=db.prepare('SELECT lat,lon,recorded_at,source,speed,altitude,heading,device_id FROM tracking_positions WHERE unit_id=? AND recorded_at>=? ORDER BY recorded_at DESC,id DESC LIMIT 2001').all(history[1],new Date(Date.now()-hours*3600000).toISOString());
    return send(200,{positions:rows.slice(0,2000).reverse(),truncated:rows.length>2000,hours});
  }
  if(!manager)fail(403,'Solo los administradores pueden registrar unidades y posiciones.');
  const assignment=route.match(/^units\/([a-z0-9-]+)\/assignment$/i);
  if(assignment&&method==='PATCH'){
    if(!visible(assignment[1]))fail(404,'Unidad no encontrada.');
    const ids=assignments(b.user_ids);
    transaction(()=>{saveAccess(assignment[1],ids);log(actor,'Asignó accesos de trackeo',assignment[1]);});
    return send(200,{ok:true});
  }
  const text=(key,max,required=false)=>{const value=b[key]??'';if(typeof value!=='string'||value.trim().length>max||(required&&!value.trim()))fail(400,'Revisá el campo '+key+'.');return value.trim();};
  if(route==='units'&&method==='POST'){
    const name=text('name',100,true),identifier=text('identifier',80,true),kind=text('kind',20,true),notes=text('notes',1000);
    if(!['vehicle','aircraft','person','equipment','camera','other'].includes(kind))fail(400,'Tipo de unidad inválido.');
    if(db.prepare('SELECT id FROM tracking_units WHERE identifier=?').get(identifier))fail(409,'Ya existe una unidad con ese identificador.');
    const id=randomUUID(),now=new Date().toISOString(),number=internalNumber(),ids=assignments(b.user_ids??[]);
    transaction(()=>{db.prepare('INSERT INTO tracking_units(id,name,identifier,kind,notes,active,created_at,updated_at,internal_number) VALUES (?,?,?,?,?,1,?,?,?)').run(id,name,identifier,kind,notes,now,now,number);saveAccess(id,ids);log(actor,'Registró unidad de trackeo',name);});
    return send(201,{id});
  }
  if(route==='integrations/wialon/sync'&&method==='POST')return service.units().then(items=>{
    const stats={created:0,positions:0,conflicts:0},now=new Date().toISOString();
    transaction(()=>{for(const item of items){
      let device=db.prepare("SELECT * FROM tracking_devices WHERE provider='wialon' AND external_id=?").get(item.external_id);
      if(!device&&item.imei){const match=db.prepare('SELECT * FROM tracking_devices WHERE imei=?').get(item.imei);if(match){if(match.provider!=='wialon'||match.external_id&&match.external_id!==item.external_id){stats.conflicts++;continue;}device=match;db.prepare('UPDATE tracking_devices SET external_id=? WHERE id=?').run(item.external_id,device.id);}}
      if(!device){const identifier='WIALON-'+item.external_id;if(db.prepare('SELECT id FROM tracking_units WHERE identifier=?').get(identifier)){stats.conflicts++;continue;}
        const unitId=randomUUID(),id=randomUUID();db.prepare('INSERT INTO tracking_units(id,name,identifier,kind,notes,active,created_at,updated_at,internal_number) VALUES (?,?,?,?,?,1,?,?,?)').run(unitId,item.name,identifier,'equipment','Importada de Wialon; revisar tipo de unidad.',now,now,nextTrackingNumber(db));
        db.prepare('INSERT INTO tracking_devices(id,unit_id,name,imei,provider,external_id,created_at) VALUES (?,?,?,?,?,?,?)').run(id,unitId,item.name,item.imei,'wialon',item.external_id,now);device={id,unit_id:unitId};stats.created++;
      }
      const unit=device.unit_id&&db.prepare('SELECT active FROM tracking_units WHERE id=?').get(device.unit_id);
      if(!unit?.active||!item.position)continue;const p=item.position;
      if(db.prepare("SELECT id FROM tracking_positions WHERE device_id=? AND source='wialon' AND recorded_at=?").get(device.id,p.recorded_at))continue;
      db.prepare('INSERT INTO tracking_positions(unit_id,lat,lon,source,recorded_at,actor_id,device_id,speed,altitude,heading) VALUES (?,?,?,?,?,?,?,?,?,?)').run(device.unit_id,p.lat,p.lon,'wialon',p.recorded_at,actor.id,device.id,p.speed,p.altitude,p.heading);stats.positions++;
    }log(actor,'Sincronizó Wialon',`${stats.created} altas; ${stats.positions} posiciones; ${stats.conflicts} conflictos`);});return send(200,stats);
  });
  const keyMatch=route.match(/^devices\/([a-z0-9-]+)\/ingest-key$/i);
  if(keyMatch&&method==='POST'){
    const device=db.prepare('SELECT * FROM tracking_devices WHERE id=?').get(keyMatch[1]);if(!device)fail(404,'Dispositivo no encontrado.');
    if(device.provider!=='rinho'||!device.imei||!device.unit_id)fail(400,'Asigná el GPS Rinho a una unidad y cargá su IMEI antes de configurar la recepción directa.');
    const key=randomBytes(8).toString('hex'),hash=hashPassword(key);
    transaction(()=>{db.prepare('UPDATE tracking_devices SET ingest_hash=?,ingest_actor_id=? WHERE id=?').run(hash,actor.id,device.id);log(actor,'Configuró clave de recepción GPS',device.name);});return send(200,{key});
  }
  const deviceMatch=route.match(/^devices(?:\/([a-z0-9-]+))?$/i);
  if(deviceMatch&&['POST','PATCH'].includes(method)&&!!deviceMatch[1]===(method==='PATCH')){
    const old=deviceMatch[1]?db.prepare('SELECT * FROM tracking_devices WHERE id=?').get(deviceMatch[1]):null;if(deviceMatch[1]&&!old)fail(404,'Dispositivo no encontrado.');
    const name=text('name',100,true),imei=text('imei',15)||null,psn=text('psn',64)||null,unit_id=text('unit_id',80)||null,manufacturer=text('manufacturer',80),model=text('model',80),provider=text('provider',20,true),external_id=text('external_id',80)||null;
    if(imei&&!/^\d{15}$/.test(imei))fail(400,'El IMEI debe contener exactamente 15 dígitos.');
    if(psn&&!/^[a-zA-Z0-9_-]+$/.test(psn))fail(400,'El PSN solo admite letras, dígitos, guion y guion bajo.');
    if(!imei&&!psn&&!external_id)fail(400,'Ingresá al menos IMEI, PSN o ID del proveedor.');
    if(!['manual','wialon','rinho'].includes(provider))fail(400,'Proveedor inválido.');
    if(unit_id&&!db.prepare('SELECT id FROM tracking_units WHERE id=? AND active=1').get(unit_id))fail(400,'Elegí una unidad habilitada.');
    for(const [column,value] of [['imei',imei],['psn',psn]])if(value&&db.prepare(`SELECT id FROM tracking_devices WHERE ${column}=? AND id<>?`).get(value,old?.id||''))fail(409,'Ya existe un dispositivo con ese '+column.toUpperCase()+'.');
    if(external_id&&db.prepare('SELECT id FROM tracking_devices WHERE provider=? AND external_id=? AND id<>?').get(provider,external_id,old?.id||''))fail(409,'Ese ID del proveedor ya está vinculado.');
    const id=old?.id||randomUUID();transaction(()=>{if(old)db.prepare('UPDATE tracking_devices SET name=?,imei=?,psn=?,manufacturer=?,model=?,provider=?,external_id=?,unit_id=? WHERE id=?').run(name,imei,psn,manufacturer,model,provider,external_id,unit_id,id);else db.prepare('INSERT INTO tracking_devices(id,unit_id,name,imei,psn,manufacturer,model,provider,external_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,unit_id,name,imei,psn,manufacturer,model,provider,external_id,new Date().toISOString());if(old&&(old.imei!==imei||old.provider!==provider))db.prepare('UPDATE tracking_devices SET ingest_hash=NULL,ingest_actor_id=NULL WHERE id=?').run(id);log(actor,old?'Editó dispositivo GPS':'Registró dispositivo GPS',name);});return send(old?200:201,{id});
  }
  const cameraMatch=route.match(/^cameras(?:\/([a-z0-9-]+))?$/i);
  if(cameraMatch&&['POST','PATCH'].includes(method)&&!!cameraMatch[1]===(method==='PATCH')){
    const old=cameraMatch[1]?db.prepare('SELECT * FROM tracking_cameras WHERE id=?').get(cameraMatch[1]):null;if(cameraMatch[1]&&!old)fail(404,'Cámara no encontrada.');
    const device_id=text('device_id',80,true),name=text('name',100,true),channel=text('channel',30,true),format=text('format',20,true),address=text('url',2048);
    if(!db.prepare('SELECT id FROM tracking_devices WHERE id=?').get(device_id))fail(400,'Elegí un dispositivo registrado.');
    if(!['hls','mp4','rtsp'].includes(format))fail(400,'Formato de video inválido.');
    if(address){let parsed;try{parsed=new URL(address);}catch{fail(400,'URL de video inválida.');}if(parsed.username||parsed.password||parsed.hash||!(format==='rtsp'?['rtsp:','rtsps:']:['https:','http:']).includes(parsed.protocol))fail(400,'Usá una URL de video sin usuario ni contraseña incrustados.');}
    if(db.prepare('SELECT id FROM tracking_cameras WHERE device_id=? AND channel=? AND id<>?').get(device_id,channel,old?.id||''))fail(409,'Ya existe ese canal en el dispositivo.');
    if(old&&old.device_id!==device_id)fail(400,'No se puede cambiar el dispositivo de una cámara existente.');
    const id=old?.id||randomUUID();transaction(()=>{if(old)db.prepare('UPDATE tracking_cameras SET name=?,channel=?,format=?,url=? WHERE id=?').run(name,channel,format,address,id);else db.prepare('INSERT INTO tracking_cameras VALUES (?,?,?,?,?,?,?)').run(id,device_id,name,channel,format,address,new Date().toISOString());log(actor,old?'Editó cámara vinculada':'Vinculó cámara a dispositivo',name);});return send(old?200:201,{id});
  }
  const match=route.match(/^units\/([a-z0-9-]+)(?:\/(position|status))?$/i);
  if(!match)fail(404,'Consulta de trackeo no encontrada.');
  const unit=db.prepare('SELECT * FROM tracking_units WHERE id=?').get(match[1]);if(!unit)fail(404,'Unidad no encontrada.');
  if(!match[2]&&method==='PATCH'){
    const name=text('name',100,true),kind=text('kind',20,true),notes=text('notes',1000);if(!['vehicle','aircraft','person','equipment','camera','other'].includes(kind))fail(400,'Tipo inválido.');
    const number=internalNumber(unit),ids=b.user_ids===undefined?null:assignments(b.user_ids);
    transaction(()=>{db.prepare('UPDATE tracking_units SET name=?,kind=?,notes=?,internal_number=?,updated_at=? WHERE id=?').run(name,kind,notes,number,new Date().toISOString(),unit.id);if(ids!==null)saveAccess(unit.id,ids);log(actor,'Editó unidad de trackeo',name);});return send(200,{ok:true});
  }
  if(match[2]==='position'&&method==='POST'){
    if(!unit.active)fail(400,'Reactivá la unidad antes de registrar una posición.');
    if(typeof b.lat!=='number'||!Number.isFinite(b.lat)||Math.abs(b.lat)>90||typeof b.lon!=='number'||!Number.isFinite(b.lon)||Math.abs(b.lon)>180)fail(400,'Ingresá una latitud y una longitud válidas.');
    const now=new Date().toISOString();transaction(()=>{db.prepare('INSERT INTO tracking_positions(unit_id,lat,lon,source,recorded_at,actor_id) VALUES (?,?,?,?,?,?)').run(unit.id,b.lat,b.lon,'manual',now,actor.id);log(actor,'Registró posición manual',unit.name);});return send(201,{ok:true});
  }
  if(match[2]==='status'&&method==='PATCH'){
    if(typeof b.active!=='boolean')fail(400,'Estado inválido.');
    transaction(()=>{db.prepare('UPDATE tracking_units SET active=?,updated_at=? WHERE id=?').run(b.active?1:0,new Date().toISOString(),unit.id);log(actor,b.active?'Reactivó unidad de trackeo':'Archivó unidad de trackeo',unit.name);});return send(200,{ok:true});
  }
  fail(405,'Método no permitido.');
}
