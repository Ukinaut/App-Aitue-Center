import net from 'node:net';
import { verifyPassword } from './auth.mjs';

// Uncompressed IPS 1.x text frames. Rinho IoT calls this mode IPS 1.0.
// Native Rinho CY/BP and IPS 2.x/CRC are deliberately not acknowledged.
export function parseIpsPosition(body,now=Date.now()){
  const f=body.split(';');if(![8,10,16].includes(f.length))return {error:'-1'};
  if(!/^\d{6}$/.test(f[0])||!/^\d{6}$/.test(f[1]))return {error:'0'};
  const d=f[0],t=f[1],year=2000+Number(d.slice(4)),month=Number(d.slice(2,4)),day=Number(d.slice(0,2)),hour=Number(t.slice(0,2)),minute=Number(t.slice(2,4)),second=Number(t.slice(4));
  const ms=Date.UTC(year,month-1,day,hour,minute,second),instant=new Date(ms);
  if(instant.getUTCFullYear()!==year||instant.getUTCMonth()!==month-1||instant.getUTCDate()!==day||hour>23||minute>59||second>59||ms>now+60000)return {error:'0'};
  function coordinate(value,hemisphere,isLat){
    const digits=isLat?2:3;if(!(new RegExp('^\\d{'+(digits+2)+'}(?:\\.\\d{1,8})?$')).test(value)||!(isLat?['N','S']:['E','W']).includes(hemisphere))return null;
    const degrees=Number(value.slice(0,digits)),minutes=Number(value.slice(digits)),n=degrees+minutes/60;
    return minutes<60&&n<=(isLat?90:180)?n*(['S','W'].includes(hemisphere)?-1:1):null;
  }
  const lat=coordinate(f[2],f[3],true),lon=coordinate(f[4],f[5],false);if(lat===null||lon===null)return {error:'10'};
  const number=(value,min,max)=>value==='NA'||value===undefined?null:/^-?\d+$/.test(value)&&Number(value)>=min&&Number(value)<=max?Number(value):NaN;
  const speed=number(f[6],0,2000),heading=number(f[7],0,359),altitude=number(f[8],-15000,100000),sats=number(f[9],0,255);
  if([speed,heading,altitude].some(Number.isNaN))return {error:'11'};if(Number.isNaN(sats)||sats===0)return {error:'12'};
  return {position:{lat,lon,speed,heading,altitude,recorded_at:instant.toISOString()}};
}

export function startTrackingReceiver({db,enabled=process.env.TRACKING_INGEST_ENABLED==='true',host=process.env.TRACKING_INGEST_HOST||'127.0.0.1',port=Number(process.env.TRACKING_INGEST_PORT||5101)}={}){
  const status={enabled,ready:false,host,port,protocol:'Wialon IPS 1.x / TCP',accepted:0,rejected:0,last_received_at:null};
  if(!enabled)return {status,ready:Promise.resolve(false),close:async()=>{}};
  if(!Number.isInteger(port)||port<0||port>65535)throw Error('Puerto de recepción GPS inválido.');
  const sockets=new Set(),failures=new Map();let resolveReady;const ready=new Promise(resolve=>{resolveReady=resolve;});
  const allowed=deviceId=>db.prepare(`SELECT d.*,u.active unit_active,a.active actor_active FROM tracking_devices d
    LEFT JOIN tracking_units u ON u.id=d.unit_id LEFT JOIN users a ON a.id=d.ingest_actor_id WHERE d.id=?`).get(deviceId);
  function save(deviceId,hash,p){
    const d=allowed(deviceId);if(!d?.unit_active||!d.actor_active||d.provider!=='rinho'||d.ingest_hash!==hash)return false;
    if(!db.prepare("SELECT id FROM tracking_positions WHERE device_id=? AND source='rinho' AND recorded_at=? AND lat=? AND lon=?").get(d.id,p.recorded_at,p.lat,p.lon))
      db.prepare('INSERT INTO tracking_positions(unit_id,lat,lon,source,recorded_at,actor_id,device_id,speed,altitude,heading) VALUES (?,?,?,?,?,?,?,?,?,?)').run(d.unit_id,p.lat,p.lon,'rinho',p.recorded_at,d.ingest_actor_id,d.id,p.speed,p.altitude,p.heading);
    status.accepted++;status.last_received_at=new Date().toISOString();return true;
  }
  const server=net.createServer(socket=>{
    const ip=socket.remoteAddress;const count=[...sockets].filter(s=>s.remoteAddress===ip).length;if(count>=10){socket.destroy();return;}sockets.add(socket);
    socket.setTimeout(10000,()=>socket.destroy());socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
    let buffer='',deviceId=null,hash=null,windowStart=Date.now(),messages=0;
    socket.on('data',chunk=>{
      if(chunk.some(byte=>byte>126||byte<9)){socket.destroy();return;}buffer+=chunk.toString('ascii');if(buffer.length>65536){socket.destroy();return;}
      while(buffer.includes('\r\n')){const end=buffer.indexOf('\r\n'),frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
        if(Date.now()-windowStart>1000){windowStart=Date.now();messages=0;}if(++messages>100){socket.destroy();return;}
        try{
          const match=frame.match(/^#(L|D|SD|P|B)#(.*)$/);if(!match){status.rejected++;socket.destroy();return;}const [,type,body]=match;
          if(type==='L'){
            if(deviceId){socket.destroy();return;}const parts=body.split(';'),blocked=failures.get(ip);
            if(parts.length!==2||!/^\d{15}$/.test(parts[0])||parts[1].length<1||parts[1].length>64||blocked?.until>Date.now()&&blocked.count>=10){socket.end('#AL#0\r\n');return;}
            const raw=db.prepare("SELECT id FROM tracking_devices WHERE imei=? AND provider='rinho'").get(parts[0]),d=raw&&allowed(raw.id);
            if(!d?.ingest_hash||!d.unit_active||!d.actor_active||!verifyPassword(parts[1],d.ingest_hash)){
              const prior=blocked?.until>Date.now()?blocked.count:0;if(failures.size>=1024&&!failures.has(ip))failures.delete(failures.keys().next().value);failures.set(ip,{count:prior+1,until:Date.now()+300000});status.rejected++;socket.end('#AL#01\r\n');return;
            }
            deviceId=d.id;hash=d.ingest_hash;socket.setTimeout(120000);socket.write('#AL#1\r\n');continue;
          }
          if(!deviceId){status.rejected++;socket.destroy();return;}
          if(type==='P'){socket.write('#AP#\r\n');continue;}
          if(type==='B'){
            const records=body.split('|');if(records.length>200){socket.write('#AB#0\r\n');continue;}let accepted=0;
            // Acknowledge only the accepted prefix so a failed record cannot erase later buffered positions.
            for(const record of records){const result=parseIpsPosition(record);if(!result.position||!save(deviceId,hash,result.position))break;accepted++;}
            status.rejected+=records.length-accepted;socket.write('#AB#'+accepted+'\r\n');continue;
          }
          const result=parseIpsPosition(body),code=result.error||(save(deviceId,hash,result.position)?'1':'-1');if(code!=='1')status.rejected++;
          socket.write('#A'+type+'#'+code+'\r\n');
        }catch{status.rejected++;socket.destroy();return;}
      }
    });
  });
  server.maxConnections=100;server.on('error',()=>{status.ready=false;status.error='No se pudo abrir el receptor TCP. Revisá el puerto y la configuración.';resolveReady(false);});
  server.listen(port,host,()=>{status.ready=true;status.port=server.address().port;resolveReady(true);});
  return {status,ready,async close(){for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));status.ready=false;}};
}
