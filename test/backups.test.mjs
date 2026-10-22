import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createBackup,verifyBackup,restoreBackup,listBackups,createBackupService} from '../backups.mjs';
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'aitue-backup-')),dataDir=path.join(root,'data'),backupDir=path.join(root,'backups');await mkdir(dataDir);const db=new DatabaseSync(path.join(dataDir,'aitue.sqlite'));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE apps(id TEXT PRIMARY KEY); CREATE TABLE grants(id TEXT); CREATE TABLE sessions(token TEXT); INSERT INTO users VALUES ('u','Persona de prueba');INSERT INTO sessions VALUES ('sesion-a-invalidar');");
  t.after(async()=>{db.close();if(path.dirname(root)===tmpdir()&&path.basename(root).startsWith('aitue-backup-'))await rm(root,{recursive:true,force:true});});return {root,dataDir,backupDir,db};}
test('Respaldos: instantánea WAL consistente, archivos sectoriales compartidos y restauración aislada',async t=>{
  const f=await fixture(t),directory='argentina-petrolera-chubut-1234567890abcdef',industry=path.join(f.dataDir,'industries',directory);await mkdir(industry,{recursive:true});
  await writeFile(path.join(f.dataDir,'industries','catalog.json'),JSON.stringify({version:1,directory}));await writeFile(path.join(industry,'original-map.html'),'<p>PRUEBA</p>');
  const source=new DatabaseSync(path.join(industry,'source.sqlite'));source.exec('CREATE TABLE wells(id INTEGER);INSERT INTO wells VALUES (7);');source.close();
  const first=await createBackup(f),firstFolder=path.join(f.backupDir,first.id);assert.equal(first.files.length,4);assert.equal((await verifyBackup(firstFolder)).id,first.id);
  f.db.exec("INSERT INTO users VALUES ('v','Otra persona');");const second=await createBackup(f);assert.equal((await readdir(path.join(f.backupDir,'objects'))).length,3);assert.equal((await listBackups(f.backupDir)).length,2);
  const restored=path.join(f.root,'restored');assert.equal((await restoreBackup({snapshot:firstFolder,target:restored})).sessions_revoked,true);
  const copy=new DatabaseSync(path.join(restored,'aitue.sqlite'));assert.equal(copy.prepare('SELECT COUNT(*) n FROM users').get().n,1);assert.equal(copy.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);copy.close();
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sessions').get().n,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM users').get().n,2);assert.equal(await readFile(path.join(restored,'industries',directory,'original-map.html'),'utf8'),'<p>PRUEBA</p>');
  await assert.rejects(()=>restoreBackup({snapshot:path.join(f.backupDir,second.id),target:restored}),/ya existe/);
});
test('Respaldos: rechaza corrupción, rutas externas y copias incompletas antes de crear el destino',async t=>{
  const f=await fixture(t),first=await createBackup(f),folder=path.join(f.backupDir,first.id),file=path.join(folder,'manifest.json'),original=await readFile(file,'utf8');
  const forged=JSON.parse(original);forged.files.push({...forged.files[0],path:'../outside',storage:'object'});await writeFile(file,JSON.stringify(forged));await assert.rejects(()=>restoreBackup({snapshot:folder,target:path.join(f.root,'forged')}),/Entrada/);
  await assert.rejects(()=>readFile(path.join(f.root,'forged','aitue.sqlite')),e=>e.code==='ENOENT');await writeFile(file,original);
  await writeFile(path.join(folder,'aitue.sqlite'),'corrupto');await assert.rejects(()=>verifyBackup(folder),/verificación/);
  await mkdir(path.join(f.backupDir,first.id+'.partial'));assert.equal((await listBackups(f.backupDir)).length,1);
  await assert.rejects(()=>verifyBackup(path.join(f.backupDir,first.id+'.partial')),/Nombre/);
});
test('Respaldos: no sigue enlaces a archivos privados externos',async t=>{
  const f=await fixture(t),directory='argentina-petrolera-chubut-1234567890abcdef',industry=path.join(f.dataDir,'industries',directory);await mkdir(industry,{recursive:true});await writeFile(path.join(f.dataDir,'industries','catalog.json'),JSON.stringify({directory}));const secret=path.join(f.root,'external.txt');await writeFile(secret,'EXTERNO');
  try{await symlink(secret,path.join(industry,'link.txt'));}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;const external=path.join(f.root,'external-directory');await mkdir(external);await writeFile(path.join(external,'secret.txt'),'EXTERNO');await symlink(external,path.join(industry,'linked-directory'),'junction');}
  await assert.rejects(()=>createBackup(f),/Enlace/);assert.equal((await listBackups(f.backupDir)).length,0);
});
test('Respaldos: programación, reanudación, exclusión de ejecuciones simultáneas y estado de error',async t=>{
  const f=await fixture(t);let now=Date.parse('2026-10-21T12:00:00Z');
  const service=createBackupService({...f,now:()=>now});await service.start();const state=await service.status();assert.equal(state.enabled,true);assert.ok(state.latest);assert.equal(state.history.length,1);assert.equal(state.last_error,false);
  const pending=service.run();await assert.rejects(()=>service.run(),e=>e.status===409);await pending;await service.stop();await assert.rejects(()=>service.run(),/deteniendo/);
  const resumed=createBackupService({...f,now:()=>now});await resumed.start();assert.equal((await resumed.status()).history.length,2);await resumed.stop();
  const disabled=createBackupService({...f,intervalHours:0});await disabled.start();assert.equal((await disabled.status()).enabled,false);await disabled.stop();
  for(const intervalHours of [-1,NaN,9000])assert.throws(()=>createBackupService({...f,intervalHours}),/BACKUP_INTERVAL/);
  const invalid=path.join(f.root,'not-a-directory');await writeFile(invalid,'archivo');const failed=createBackupService({...f,backupDir:invalid});await failed.start();assert.equal((await failed.status()).last_error,true);await failed.stop();
});
