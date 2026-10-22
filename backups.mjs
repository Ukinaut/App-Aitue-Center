import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, lstat, rename, copyFile, link, unlink } from 'node:fs/promises';
import path from 'node:path';

const SNAPSHOT=/^aitue-\d{8}T\d{9}Z-[a-f0-9-]{36}$/;
const HASH=/^[a-f0-9]{64}$/;
const relative=p=>typeof p==='string'&&p.length<400&&!p.includes('\\')&&!p.includes(':')&&!p.startsWith('/')&&p.split('/').every(v=>v&&v!=='.'&&v!=='..');
async function realFile(file){const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw Error('Archivo de respaldo inválido.');return info;}
async function realDirectory(dir){const info=await lstat(dir);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Carpeta de respaldo inválida.');}
async function safeFile(root,rel){if(!relative(rel))throw Error('Ruta de respaldo inválida.');let current=root;await realDirectory(current);const parts=rel.split('/');for(const part of parts.slice(0,-1)){current=path.join(current,part);await realDirectory(current);}const file=path.join(root,...parts);await realFile(file);return file;}
export async function sha256(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
function checkDatabase(file,portal=false){let check;try{check=new DatabaseSync(file,{readOnly:true});check.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON');if(check.prepare('PRAGMA quick_check').all().some(r=>r.quick_check!=='ok'))throw Error('Base de respaldo inválida.');if(portal)for(const name of ['users','apps','grants','sessions'])if(!check.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name))throw Error('El respaldo no contiene la base del portal.');}finally{check?.close();}}
async function loadManifest(snapshot){
  const folder=path.resolve(snapshot);if(!SNAPSHOT.test(path.basename(folder)))throw Error('Nombre de respaldo inválido.');
  const file=await safeFile(folder,'manifest.json'),manifest=JSON.parse(await readFile(file,'utf8'));
  if(manifest.version!==1||manifest.id!==path.basename(folder)||!Number.isFinite(Date.parse(manifest.created_at))||!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>10000)throw Error('Manifiesto de respaldo inválido.');
  const paths=new Set();for(const f of manifest.files){if(!relative(f.path)||paths.has(f.path)||!HASH.test(f.sha256)||!Number.isSafeInteger(f.bytes)||f.bytes<0||!['database','object'].includes(f.storage)||f.storage==='database'&&f.path!=='aitue.sqlite'||f.storage==='object'&&!f.path.startsWith('industries/'))throw Error('Entrada de respaldo inválida.');paths.add(f.path);}
  if(!manifest.files.some(f=>f.path==='aitue.sqlite'&&f.storage==='database'))throw Error('Falta la base del portal.');
  return {folder,manifest};
}
async function verifyFiles(folder,manifest,root){
  for(const f of manifest.files){const file=f.storage==='database'?await safeFile(folder,'aitue.sqlite'):await safeFile(root,'objects/'+f.sha256),info=await realFile(file);
    if(info.size!==f.bytes||await sha256(file)!==f.sha256)throw Error('La verificación del respaldo falló.');
    if(f.path.endsWith('.sqlite'))checkDatabase(file,f.path==='aitue.sqlite');
  }
  return manifest;
}
export async function verifyBackup(snapshot){const {folder,manifest}=await loadManifest(snapshot);return verifyFiles(folder,manifest,path.dirname(folder));}
async function sectorFiles(dataDir){
  const root=path.join(dataDir,'industries');let pointer;try{pointer=await readFile(await safeFile(root,'catalog.json'),'utf8');}catch(e){if(e.code==='ENOENT')return [];throw e;}
  const {directory}=JSON.parse(pointer);if(!/^argentina-petrolera-chubut-[a-f0-9]{16}$/.test(directory))throw Error('Catálogo de datos inválido.');
  const files=['industries/catalog.json'];
  async function visit(rel){const dir=path.join(dataDir,...rel.split('/'));await realDirectory(dir);for(const entry of await readdir(dir,{withFileTypes:true})){if(entry.isSymbolicLink())throw Error('Enlace no admitido en datos sectoriales.');const name=rel+'/'+entry.name;if(entry.isDirectory())await visit(name);else if(entry.isFile())files.push(name);else throw Error('Archivo sectorial inválido.');}}
  await visit('industries/'+directory);return files;
}
export async function createBackup({db,dataDir,backupDir,now=Date.now}){
  await mkdir(backupDir,{recursive:true,mode:0o700});await realDirectory(backupDir);
  const objects=path.join(backupDir,'objects');await mkdir(objects,{recursive:true,mode:0o700});await realDirectory(objects);
  const id='aitue-'+new Date(now()).toISOString().replace(/[-:.]/g,'')+'-'+randomUUID(),folder=path.join(backupDir,id),staging=folder+'.partial';
  await mkdir(staging,{mode:0o700});const files=[];
  // Una carpeta .partial nunca se presenta como un respaldo terminado.
  const database=path.join(staging,'aitue.sqlite');await backup(db,database);checkDatabase(database,true);
  files.push({path:'aitue.sqlite',storage:'database',bytes:(await lstat(database)).size,sha256:await sha256(database)});
  const sector=await sectorFiles(dataDir);
  for(const rel of sector){
    const source=await safeFile(dataDir,rel),hash=await sha256(source),object=path.join(objects,hash);
    try{await realFile(object);if(await sha256(object)!==hash)throw Error('Un objeto guardado no superó la verificación.');}
    catch(e){if(e.code!=='ENOENT')throw e;const temporary=object+'.'+randomUUID()+'.partial';await copyFile(source,temporary);try{if(await sha256(temporary)!==hash)throw Error('Los datos sectoriales cambiaron durante el respaldo.');try{await link(temporary,object);}catch(error){if(error.code!=='EEXIST')throw error;}}finally{await unlink(temporary);}}
    files.push({path:rel,storage:'object',bytes:(await realFile(object)).size,sha256:hash});
  }
  // No aceptar un catálogo cambiado mientras se copiaba el conjunto inmutable.
  const catalog=files.find(f=>f.path==='industries/catalog.json');if(catalog&&await sha256(await safeFile(dataDir,catalog.path))!==catalog.sha256)throw Error('El catálogo cambió durante el respaldo.');
  const manifest={version:1,id,created_at:new Date(now()).toISOString(),scope:'portal-and-current-industry',files};
  await writeFile(path.join(staging,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});
  await verifyFiles(staging,manifest,backupDir);await rename(staging,folder);return manifest;
}
export async function listBackups(backupDir){
  let entries;try{entries=await readdir(backupDir,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return [];throw e;}
  const result=[];for(const entry of entries){if(!entry.isDirectory()||!SNAPSHOT.test(entry.name))continue;try{result.push((await loadManifest(path.join(backupDir,entry.name))).manifest);}catch{}}
  return result.sort((a,b)=>b.created_at.localeCompare(a.created_at));
}
export async function restoreBackup({snapshot,target}){
  target=path.resolve(target);try{await lstat(target);throw Error('El destino ya existe. Elegí una carpeta nueva.');}catch(e){if(e.code!=='ENOENT')throw e;}
  const manifest=await verifyBackup(snapshot),folder=path.resolve(snapshot),backupRoot=path.dirname(folder);
  await mkdir(target,{mode:0o700});await writeFile(path.join(target,'.restore-incomplete'),'Restauración en curso',{flag:'wx',mode:0o600});
  for(const f of manifest.files){const source=f.storage==='database'?path.join(folder,'aitue.sqlite'):path.join(backupRoot,'objects',f.sha256),destination=path.join(target,...f.path.split('/'));await mkdir(path.dirname(destination),{recursive:true,mode:0o700});await copyFile(source,destination);if(await sha256(destination)!==f.sha256)throw Error('La copia restaurada no superó la verificación.');}
  let restored;try{restored=new DatabaseSync(path.join(target,'aitue.sqlite'));restored.exec('DELETE FROM sessions; PRAGMA journal_mode=DELETE;');}finally{restored?.close();}
  await unlink(path.join(target,'.restore-incomplete'));return {id:manifest.id,files:manifest.files.length,sessions_revoked:true};
}
export function createBackupService({db,dataDir,backupDir=path.join(dataDir,'backups'),intervalHours=24,now=Date.now}){
  if(!Number.isFinite(intervalHours)||intervalHours<0||intervalHours>8760)throw Error('BACKUP_INTERVAL_HOURS debe estar entre 0 y 8760.');
  let pending=null,stopped=false,timer=null,lastError=false,lastAttempt=0,latest=null;
  const summary=m=>({id:m.id,created_at:m.created_at,files:m.files.length,bytes:m.files.reduce((sum,f)=>sum+f.bytes,0),includes_industry:m.files.some(f=>f.path.startsWith('industries/'))});
  async function run(){if(stopped)throw Error('El servicio se está deteniendo.');if(pending)throw Object.assign(Error('Hay un respaldo en curso.'),{status:409});lastAttempt=now();
    pending=(async()=>{try{const manifest=await createBackup({db,dataDir,backupDir,now});latest=summary(manifest);lastError=false;return latest;}catch(error){lastError=true;throw error;}finally{pending=null;}})();return pending;
  }
  async function tick(){if(stopped||pending||!intervalHours)return;if((latest?now()-Date.parse(latest.created_at)>=intervalHours*3600000:true)&&now()-lastAttempt>=60000)await run();}
  return {
    async start(){try{const previous=(await listBackups(backupDir))[0];if(previous){try{latest=summary(await verifyBackup(path.join(backupDir,previous.id)));}catch{lastError=true;}}if(intervalHours)await tick();}catch{lastError=true;}
      if(intervalHours&&!stopped){timer=setInterval(()=>tick().catch(()=>{}),60000);timer.unref();}
    },
    run,
    async status(){let history=[];try{history=(await listBackups(backupDir)).slice(0,20).map(summary);}catch{lastError=true;}return {enabled:intervalHours>0,interval_hours:intervalHours,running:!!pending,last_error:lastError,latest,next_at:intervalHours&&latest?new Date(Date.parse(latest.created_at)+intervalHours*3600000).toISOString():null,history};},
    async stop(){stopped=true;clearInterval(timer);await pending?.catch(()=>{});}
  };
}
