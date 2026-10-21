import {randomUUID} from 'node:crypto';
export const gbToday=(now=Date.now())=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
export function nextGbMonth(start,anchor=Number(start.slice(8))){
  const [y,m]=start.split('-').map(Number),last=new Date(Date.UTC(y,m+1,0)).getUTCDate();
  return new Date(Date.UTC(y,m,Math.min(anchor,last))).toISOString().slice(0,10);
}
export function initializeGbPeriods(db){
  db.exec(`CREATE TABLE IF NOT EXISTS gb_cycles(id TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES gb_devices(id),source TEXT NOT NULL CHECK(source IN ('satellite','sim')),start_date TEXT NOT NULL,end_date TEXT NOT NULL,capacity INTEGER NOT NULL,allocated INTEGER NOT NULL,actor_id TEXT REFERENCES users(id),created_at TEXT NOT NULL,UNIQUE(device_id,source,start_date));
    CREATE TABLE IF NOT EXISTS gb_legacy_plans(device_id TEXT NOT NULL REFERENCES gb_devices(id),source TEXT NOT NULL,capacity INTEGER NOT NULL,allocated INTEGER NOT NULL,PRIMARY KEY(device_id,source));
    CREATE TABLE IF NOT EXISTS gb_cycle_settings(device_id TEXT NOT NULL REFERENCES gb_devices(id),source TEXT NOT NULL,anchor_day INTEGER NOT NULL,auto_renew INTEGER NOT NULL,capacity INTEGER NOT NULL,allocated INTEGER NOT NULL,PRIMARY KEY(device_id,source));
    CREATE TABLE IF NOT EXISTS gb_plan_changes(id TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES gb_devices(id),source TEXT NOT NULL,cycle_id TEXT REFERENCES gb_cycles(id),action TEXT NOT NULL,before_capacity INTEGER,before_allocated INTEGER,capacity INTEGER NOT NULL,allocated INTEGER NOT NULL,actor_id TEXT REFERENCES users(id),reason TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS gb_corrections(id TEXT PRIMARY KEY,usage_id TEXT NOT NULL REFERENCES gb_usage(id),delta INTEGER NOT NULL,before_amount INTEGER NOT NULL,after_amount INTEGER NOT NULL,reason TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS gb_corrections_usage ON gb_corrections(usage_id);
    CREATE INDEX IF NOT EXISTS gb_cycles_device ON gb_cycles(device_id,source,start_date);`);
  if(!db.prepare('PRAGMA table_info(gb_usage)').all().some(c=>c.name==='cycle_id'))db.exec('ALTER TABLE gb_usage ADD COLUMN cycle_id TEXT REFERENCES gb_cycles(id)');
  db.exec(`CREATE VIEW IF NOT EXISTS gb_usage_effective AS SELECT u.*,u.amount+COALESCE((SELECT SUM(c.delta) FROM gb_corrections c WHERE c.usage_id=u.id),0) effective_amount,(SELECT COUNT(*) FROM gb_corrections c WHERE c.usage_id=u.id) correction_count FROM gb_usage u;
    CREATE INDEX IF NOT EXISTS gb_usage_cycle ON gb_usage(cycle_id);`);
}
export function gbPlanChange(db,{device_id,source,cycle_id=null,action,before_capacity=null,before_allocated=null,capacity,allocated,actor_id=null,reason='',now=Date.now()}){
  db.prepare('INSERT INTO gb_plan_changes VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),device_id,source,cycle_id,action,before_capacity,before_allocated,capacity,allocated,actor_id,reason,new Date(now).toISOString());
}
export function setGbPlan(db,device,source,capacity,allocated){
  if(source==='satellite')db.prepare('UPDATE gb_devices SET capacity=?,satellite_allocated=? WHERE id=?').run(capacity,allocated,device.id);
  else {db.prepare('UPDATE gb_sims SET capacity=? WHERE id=?').run(capacity,device.sim_id);db.prepare('UPDATE gb_devices SET sim_allocated=? WHERE id=?').run(allocated,device.id);}
  db.prepare('UPDATE gb_devices SET allocated=satellite_allocated+sim_allocated WHERE id=?').run(device.id);
}
export function createGbCycle(db,device,source,start,settings,{actor_id=null,now=Date.now(),action='renew'}={}){
  const id=randomUUID();let end=nextGbMonth(start,settings.anchor_day);
  if(action==='start'){const [year,month]=start.split('-').map(Number),last=new Date(Date.UTC(year,month,0)).getUTCDate(),candidate=start.slice(0,8)+String(Math.min(last,settings.anchor_day)).padStart(2,'0');if(candidate>start)end=candidate;}
  db.prepare('INSERT INTO gb_cycles VALUES (?,?,?,?,?,?,?,?,?)').run(id,device.id,source,start,end,settings.capacity,settings.allocated,actor_id,new Date(now).toISOString());
  setGbPlan(db,device,source,settings.capacity,settings.allocated);
  gbPlanChange(db,{device_id:device.id,source,cycle_id:id,action,capacity:settings.capacity,allocated:settings.allocated,actor_id,now,reason:action==='auto_renew'?'Renovación mensual automática':'Inicio de período mensual'});
  return id;
}
export function renewGbCycles(db,now=Date.now()){
  const today=gbToday(now);db.exec('BEGIN IMMEDIATE');
  try{
    for(const setting of db.prepare('SELECT * FROM gb_cycle_settings WHERE auto_renew=1').all()){
      const device=db.prepare('SELECT * FROM gb_devices WHERE id=?').get(setting.device_id);
      if(!device?.active||setting.source==='sim'&&!device.sim_id||setting.source==='satellite'&&!device.satellite_enabled)continue;
      let latest=db.prepare('SELECT * FROM gb_cycles WHERE device_id=? AND source=? ORDER BY start_date DESC LIMIT 1').get(device.id,setting.source),count=0;
      while(latest&&latest.end_date<=today&&count++<120){createGbCycle(db,device,setting.source,latest.end_date,setting,{now,action:'auto_renew'});latest=db.prepare('SELECT * FROM gb_cycles WHERE device_id=? AND source=? ORDER BY start_date DESC LIMIT 1').get(device.id,setting.source);}
    }
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
}
export function gbChannel(db,device,source,now=Date.now()){
  const today=gbToday(now),setting=db.prepare('SELECT * FROM gb_cycle_settings WHERE device_id=? AND source=?').get(device.id,source);
  const cycle=db.prepare('SELECT * FROM gb_cycles WHERE device_id=? AND source=? AND start_date<=? ORDER BY start_date DESC LIMIT 1').get(device.id,source,today);
  const expired=!!cycle&&cycle.end_date<=today;
  const used=db.prepare('SELECT COALESCE(SUM(effective_amount),0) used FROM gb_usage_effective WHERE device_id=? AND source=? AND cycle_id IS ?').get(device.id,source,cycle?.id||null).used;
  const capacity=source==='satellite'?device.capacity:(device.sim_capacity??db.prepare('SELECT capacity FROM gb_sims WHERE id=?').get(device.sim_id)?.capacity??0);
  return {mode:cycle?(expired?'expired':'monthly'):'legacy',capacity:expired?0:cycle?.capacity??capacity,allocated:expired?0:cycle?.allocated??device[source+'_allocated'],used:expired?0:used,cycle:cycle?{id:cycle.id,start_date:cycle.start_date,end_date:cycle.end_date,capacity:cycle.capacity/1000,allocated:cycle.allocated/1000,used:used/1000}:null,auto_renew:!!setting?.auto_renew,template:setting?{capacity:setting.capacity/1000,allocated:setting.allocated/1000,anchor_day:setting.anchor_day}:null};
}
