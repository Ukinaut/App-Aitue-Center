export const trackingManager=actor=>!actor||['superadmin','admin'].includes(actor.role);
export function trackingScope(actor,alias='u'){
  return trackingManager(actor)?{sql:'1=1',values:[]}:{sql:`EXISTS (SELECT 1 FROM tracking_unit_access access WHERE access.unit_id=${alias}.id AND access.user_id=?)`,values:[actor.id]};
}
export function nextTrackingNumber(db){
  let n=1;
  while(db.prepare('SELECT 1 FROM tracking_units WHERE internal_number=? COLLATE NOCASE').get(`TRK-${String(n).padStart(6,'0')}`))n++;
  return `TRK-${String(n).padStart(6,'0')}`;
}
export function trackingIdentity(row,actor){
  return trackingManager(actor)?row:{...row,name:row.internal_number,identifier:row.internal_number,...('notes' in row?{notes:''}:{})};
}
