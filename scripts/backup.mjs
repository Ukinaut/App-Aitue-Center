import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createBackup,verifyBackup,restoreBackup} from '../backups.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args=process.argv.slice(2),command=args.shift();
function option(name){const i=args.indexOf(name);if(i<0)return null;const value=args[i+1];if(!value||value.startsWith('--'))throw Error('Falta un valor para '+name);args.splice(i,2);return value;}
let db;
try{
  if(command==='create'){
    if(args.length)throw Error('Uso: npm run backup');
    const dataDir=path.resolve(process.env.DATA_DIR||path.join(root,'data')),backupDir=path.resolve(process.env.BACKUP_DIR||path.join(dataDir,'backups'));
    db=new DatabaseSync(path.join(dataDir,'aitue.sqlite'),{readOnly:true});
    const result=await createBackup({db,dataDir,backupDir});console.log('Respaldo creado y verificado: '+path.join(backupDir,result.id));
  }else if(command==='verify'){
    const snapshot=option('--backup');if(!snapshot||args.length)throw Error('Uso: npm run backup:verify -- --backup RUTA_DEL_RESPALDO');
    const result=await verifyBackup(snapshot);console.log('Respaldo válido: '+result.id+' · '+result.files.length+' archivos.');
  }else if(command==='restore'){
    const snapshot=option('--backup'),target=option('--target');if(!snapshot||!target||args.length)throw Error('Uso: npm run backup:restore -- --backup RUTA_DEL_RESPALDO --target CARPETA_NUEVA');
    const result=await restoreBackup({snapshot,target});console.log('Restauración verificada en '+path.resolve(target)+' · Sesiones revocadas · '+result.files+' archivos.');
  }else throw Error('Comando de respaldo inválido.');
}catch(e){console.error(e.message);process.exitCode=1;}finally{db?.close();}
