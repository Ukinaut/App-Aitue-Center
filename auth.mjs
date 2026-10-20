import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const roles = ['superadmin', 'admin', 'controlador', 'usuario'];
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(hash, 'hex'));
}
export function descendants(actor, users) {
  const ids = new Set([actor.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const u of users) if (ids.has(u.parent_id) && !ids.has(u.id)) { ids.add(u.id); changed = true; }
  }
  return ids;
}
export function canManage(actor, target, users) {
  return actor.id !== target.id && (actor.role === 'superadmin' ||
    (roles.indexOf(actor.role) < roles.indexOf(target.role) && descendants(actor, users).has(target.id)));
}
export function validateGrant(actor, grant, creating = true) {
  if (creating && actor.role !== 'superadmin' && !actor.can_create) return 'No tenés permiso para crear subusuarios.';
  if (!roles.includes(grant.role) || (actor.role !== 'superadmin' && roles.indexOf(grant.role) <= roles.indexOf(actor.role))) return 'Solo podés asignar roles inferiores al tuyo.';
  if (grant.role === 'usuario' && grant.can_create) return 'El usuario final no puede crear subusuarios porque no existe un rol inferior.';
  if (grant.can_create && actor.role !== 'superadmin' && !actor.can_create) return 'No podés delegar la creación de subusuarios si no tenés ese permiso.';
  if (!Array.isArray(grant.apps) || grant.apps.some(x => typeof x !== 'string')) return 'Los accesos no son válidos.';
  if (actor.role !== 'superadmin' && grant.apps.some(id => !actor.apps.includes(id))) return 'No podés otorgar acceso a aplicaciones que no tenés habilitadas.';
  return null;
}
