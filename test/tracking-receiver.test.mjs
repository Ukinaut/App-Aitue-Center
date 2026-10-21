import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {hashPassword} from '../auth.mjs';
import {initializeTracking} from '../tracking.mjs';
import {parseIpsPosition,startTrackingReceiver} from '../tracking-receiver.mjs';

const stamp=(ms)=>{const d=new Date(ms),pad=n=>String(n).padStart(2,'0');return pad(d.getUTCDate())+pad(d.getUTCMonth()+1)+String(d.getUTCFullYear()).slice(-2)+';'+pad(d.getUTCHours())+pad(d.getUTCMinutes())+pad(d.getUTCSeconds());};
const body=ms=>stamp(ms)+';3459.4180;S;05842.8140;W;40;180;120;8';
test('IPS 1.x: coordenadas, UTC, datos ausentes y rechazo de fechas o minutos inválidos',()=>{
  const now=Date.now(),parsed=parseIpsPosition(body(now),now).position;
  assert.ok(Math.abs(parsed.lat-(-34-59.418/60))<1e-8);assert.ok(Math.abs(parsed.lon-(-58-42.814/60))<1e-8);assert.equal(parsed.speed,40);assert.equal(parsed.altitude,120);
  assert.equal(parseIpsPosition(body(now).replace('3459.4180','3460.0000'),now).error,'10');
  assert.equal(parseIpsPosition(body(now).replace(';8',';0'),now).error,'12');
  assert.equal(parseIpsPosition('310226;000000;3459.4180;S;05842.8140;W;40;180;120;8',now).error,'0');
  assert.equal(parseIpsPosition(body(now+120000),now).error,'0');
  assert.equal(parseIpsPosition('NA;NA;3459.4180;S;05842.8140;W;40;180;120;8',now).error,'0');
  assert.equal(parseIpsPosition(stamp(now)+';3459.4180;S;05842.8140;W;40;180',now).position.altitude,null);
});

test('Receptor TCP: login, fragmentos, ACK después de guardar, duplicados y clave renovada',async t=>{
  const db=new DatabaseSync(':memory:');db.exec("PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY,active INTEGER); INSERT INTO users VALUES ('root',1); CREATE TABLE apps(id TEXT PRIMARY KEY,name TEXT,description TEXT,url TEXT,color TEXT);");initializeTracking(db);
  const now=new Date().toISOString();db.prepare('INSERT INTO tracking_units VALUES (?,?,?,?,?,1,?,?)').run('unit','Spider de prueba','KIT-TEST','vehicle','',now,now);
  db.prepare('INSERT INTO tracking_devices(id,unit_id,name,imei,provider,created_at,ingest_hash,ingest_actor_id) VALUES (?,?,?,?,?,?,?,?)').run('gps','unit','Spider','001234567890123','rinho',now,hashPassword('test-device-password'),'root');
  const receiver=startTrackingReceiver({db,enabled:true,host:'127.0.0.1',port:0});const clients=[];
  t.after(async()=>{for(const socket of clients)socket.destroy();await receiver.close();db.close();});assert.equal(await receiver.ready,true);
  async function connect(){const socket=net.createConnection({host:'127.0.0.1',port:receiver.status.port});clients.push(socket);await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});let buffer='',pending=[],lines=[];socket.on('data',chunk=>{buffer+=chunk.toString();while(buffer.includes('\r\n')){const end=buffer.indexOf('\r\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+2);if(pending.length)pending.shift()(line);else lines.push(line);}});return {socket,next(){if(lines.length)return Promise.resolve(lines.shift());return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('ACK no recibido')),3000);pending.push(value=>{clearTimeout(timer);resolve(value);});});},async send(frame){socket.write(frame+'\r\n');return this.next();}};}
  const wrong=await connect();assert.equal(await wrong.send('#L#001234567890123;wrong-password'),'#AL#01');
  const client=await connect();client.socket.write('#L#00123456');client.socket.write('7890123;test-device-password\r\n');assert.equal(await client.next(),'#AL#1');
  const record=body(Date.now()-5000);assert.equal(await client.send('#SD#'+record),'#ASD#1');assert.equal(db.prepare('SELECT COUNT(*) n FROM tracking_positions').get().n,1);
  assert.equal(db.prepare('SELECT source FROM tracking_positions').get().source,'rinho');
  assert.equal(await client.send('#SD#'+record),'#ASD#1');assert.equal(db.prepare('SELECT COUNT(*) n FROM tracking_positions').get().n,1);
  assert.equal(await client.send('#SD#'+record.replace('3459.4180','3460.0000')),'#ASD#10');
  assert.equal(await client.send('#B#'+body(Date.now()-10000)+'|invalid'),'#AB#1');assert.equal(db.prepare('SELECT COUNT(*) n FROM tracking_positions').get().n,2);
  assert.equal(await client.send('#P#'),'#AP#');
  db.prepare('UPDATE tracking_devices SET ingest_hash=? WHERE id=?').run(hashPassword('renewed-device-password'),'gps');
  assert.equal(await client.send('#SD#'+body(Date.now()-15000)),'#ASD#-1');assert.equal(db.prepare('SELECT COUNT(*) n FROM tracking_positions').get().n,2);
});
