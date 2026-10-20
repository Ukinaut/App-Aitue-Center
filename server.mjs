import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hashPassword, verifyPassword, roles, canManage, validateGrant } from './auth.mjs';
import { initializeGb, handleGb } from './gb.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'aitue.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL, parent_id TEXT REFERENCES users(id), can_create INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS apps (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, url TEXT NOT NULL, color TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS grants (user_id TEXT REFERENCES users(id), app_id TEXT REFERENCES apps(id), PRIMARY KEY(user_id,app_id));
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, actor_id TEXT, actor_name TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, created_at TEXT NOT NULL);`);
initializeGb(db);
const all = () => db.prepare('SELECT id,name,email,role,parent_id,can_create,active,created_at FROM users ORDER BY created_at').all().map(u => ({ ...u, can_create: !!u.can_create, active: !!u.active, apps: db.prepare('SELECT app_id FROM grants WHERE user_id=?').all(u.id).map(x => x.app_id) }));
const log = (actor, action, target) => db.prepare('INSERT INTO audit VALUES (?,?,?,?,?,?)').run(randomUUID(), actor?.id ?? null, actor?.name || 'Configuración inicial', action, target, new Date().toISOString());
const digest = token => createHash('sha256').update(token).digest('hex');
const attempts = new Map();
setInterval(() => { const now = Date.now(); for (const [key, v] of attempts) if (v.until < now) attempts.delete(key); db.prepare('DELETE FROM sessions WHERE expires<?').run(now); }, 60000).unref();
function limit(key) { const now = Date.now(); let v = attempts.get(key); if (!v || v.until < now) { v = { count: 0, until: now + 15*60000 }; attempts.set(key, v); } return ++v.count <= 15; }
function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (e) { db.exec('ROLLBACK'); throw e; } }
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
async function body(req) { let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 32768) fail(413, 'Solicitud demasiado grande.'); } try { return JSON.parse(raw || '{}'); } catch { fail(400, 'Solicitud inválida.'); } }
function details(b) {
  if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100) fail(400, 'Ingresá un nombre de hasta 100 caracteres.');
  if (typeof b.email !== 'string' || b.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) fail(400, 'Ingresá un correo válido.');
  if (typeof b.password !== 'string' || b.password.length < 12 || b.password.length > 128) fail(400, 'La contraseña debe tener entre 12 y 128 caracteres.');
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('X-Frame-Options','DENY'); res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  const url = new URL(req.url, 'http://localhost');
  const secure = process.env.COOKIE_SECURE === 'true';
  const cookie = (value, age) => `aitue_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(payload)); };
  try {
    if (!url.pathname.startsWith('/api/')) {
      if (!['GET','HEAD'].includes(req.method)) fail(405, 'Método no permitido.');
      const assets = { '/': ['index.html','text/html'], '/app.js': ['app.js','text/javascript'], '/theme.css': ['theme.css','text/css'], '/favicon.svg': ['favicon.svg','image/svg+xml'], '/fonts/manrope.ttf': ['fonts/manrope.ttf','font/ttf'], '/fonts/syne.ttf': ['fonts/syne.ttf','font/ttf'] };
      Object.assign(assets, {
        '/chrome.js': ['chrome.js','text/javascript'], '/brand.css': ['brand.css','text/css'], '/particles.js': ['particles.js','text/javascript'],
        '/gb.js': ['gb.js','text/javascript'], '/gb.css': ['gb.css','text/css'],
        '/brand/logo-nav.png': ['brand/logo-nav.png','image/png'], '/brand/logo-footer.png': ['brand/logo-footer.png','image/png'], '/brand/favicon.jpg': ['brand/favicon.jpg','image/jpeg'],
        '/fonts/outfit.ttf': ['fonts/outfit.ttf','font/ttf'], '/fonts/inter.ttf': ['fonts/inter.ttf','font/ttf'], '/fonts/share-tech-mono.ttf': ['fonts/share-tech-mono.ttf','font/ttf']
      });
      const asset = assets[url.pathname]; if (!asset) fail(404, 'No encontrado.');
      res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8`, 'Cache-Control': 'no-cache' }); res.end(req.method === 'HEAD' ? undefined : readFileSync(path.join(root,'public',asset[0]))); return;
    }
    if (!['GET','POST','PATCH'].includes(req.method)) fail(405, 'Método no permitido.');
    if (req.method !== 'GET') {
      if (req.headers['x-aitue-request'] !== '1') fail(403, 'Solicitud no permitida.');
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) fail(403, 'Origen no permitido.');
    }
    const b = req.method === 'GET' ? {} : await body(req);
    const users = all();
    const rawToken = req.headers.cookie?.match(/(?:^|;\s*)aitue_session=([^;]+)/)?.[1];
    const session = rawToken ? db.prepare('SELECT user_id FROM sessions WHERE token=? AND expires>?').get(digest(rawToken), Date.now()) : null;
    const actor = users.find(u => u.id === session?.user_id && u.active);
    const newSession = id => { const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(token), id, Date.now()+8*3600000); res.setHeader('Set-Cookie', cookie(token, 8*3600)); };
    if (url.pathname === '/api/status' && req.method === 'GET') return send(200, { needsSetup: users.length === 0, user: actor || null });
    if (url.pathname === '/api/setup' && req.method === 'POST') {
      if (users.length) fail(403, 'La configuración inicial ya fue realizada.');
      if (!limit(`setup:${req.socket.remoteAddress}`)) fail(429, 'Demasiados intentos. Esperá 15 minutos.');
      details(b); const id = randomUUID();
      transaction(() => { if (db.prepare('SELECT count(*) n FROM users').get().n) fail(403,'La configuración inicial ya fue realizada.'); db.prepare('INSERT INTO users VALUES (?,?,?,?,?,NULL,1,1,?)').run(id,b.name.trim(),b.email.trim().toLowerCase(),hashPassword(b.password),'superadmin',new Date().toISOString()); log(null,'Creó la cuenta principal',b.name.trim()); });
      newSession(id); return send(201, { ok: true });
    }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      if (!limit(`login:${req.socket.remoteAddress}`)) fail(429, 'Demasiados intentos. Esperá 15 minutos.');
      const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
      const row = db.prepare('SELECT * FROM users WHERE email=?').get(email);
      const valid = verifyPassword(typeof b.password === 'string' ? b.password.slice(0,129) : '', row?.password || hashPassword('dummy-account-password'));
      if (!row || !valid || !row.active) fail(401, 'Correo o contraseña incorrectos.');
      if (rawToken) db.prepare('DELETE FROM sessions WHERE token=?').run(digest(rawToken));
      newSession(row.id); log(row,'Inició sesión',row.name); return send(200, { ok: true });
    }
    if (!actor) fail(401, 'Iniciá sesión para continuar.');
    if (url.pathname.startsWith('/api/gb/')) return handleGb({db,actor,users,url,method:req.method,b,send,fail,transaction,log});
    if (url.pathname === '/api/logout' && req.method === 'POST') { if (rawToken) db.prepare('DELETE FROM sessions WHERE token=?').run(digest(rawToken)); res.setHeader('Set-Cookie',cookie('',0)); return send(200,{ok:true}); }
    if (url.pathname === '/api/dashboard' && req.method === 'GET') {
      const visible = users.filter(u => u.id === actor.id || canManage(actor,u,users));
      const apps = db.prepare('SELECT * FROM apps ORDER BY name').all().filter(a => actor.role === 'superadmin' || actor.apps.includes(a.id));
      const ids = new Set(visible.map(u => u.id));
      const audit = db.prepare('SELECT * FROM audit ORDER BY created_at DESC LIMIT 500').all().filter(a => actor.role === 'superadmin' || ids.has(a.actor_id)).slice(0,30);
      return send(200,{user:actor,users:visible,apps,audit});
    }
    if (url.pathname === '/api/users' && req.method === 'POST') {
      details(b); const grant = {role:b.role,apps:b.apps,can_create:b.role === 'superadmin' || !!b.can_create};
      const error = validateGrant(actor,grant); if (error) fail(403,error);
      if (grant.apps.some(id => !db.prepare('SELECT id FROM apps WHERE id=?').get(id))) fail(400,'Una aplicación no existe.');
      if (users.some(u => u.email === b.email.trim().toLowerCase())) fail(409,'Ese correo ya está registrado.');
      const id = randomUUID();
      transaction(() => { db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,1,?)').run(id,b.name.trim(),b.email.trim().toLowerCase(),hashPassword(b.password),b.role,b.role === 'superadmin' ? null : actor.id,Number(grant.can_create),new Date().toISOString()); for (const app of new Set(b.apps)) db.prepare('INSERT INTO grants VALUES (?,?)').run(id,app); log(actor,'Creó un usuario',b.name.trim()); });
      return send(201,{ok:true});
    }
    if (/^\/api\/users\/[^/]+$/.test(url.pathname) && req.method === 'PATCH') {
      const target = users.find(u => u.id === url.pathname.split('/').at(-1));
      if (!target || !canManage(actor,target,users)) fail(403,'No podés administrar este usuario.');
      if (b.active !== undefined && typeof b.active !== 'boolean') fail(400,'Estado inválido.');
      const grant = {role:target.role, apps:b.apps ?? target.apps, can_create:target.role === 'superadmin' ? true : b.can_create ?? target.can_create};
      if (typeof grant.can_create !== 'boolean') fail(400,'Permiso inválido.');
      const error = validateGrant(actor,grant,false); if (error) fail(403,error);
      if (b.active === true) {
        let parent = users.find(u => u.id === target.parent_id);
        while (parent) { if (!parent.active) fail(400,'Reactivá primero la cuenta superior de esta rama.'); parent = users.find(u => u.id === parent.parent_id); }
      }
      if (grant.apps.some(id => !db.prepare('SELECT id FROM apps WHERE id=?').get(id))) fail(400,'Una aplicación no existe.');
      transaction(() => {
        db.prepare('UPDATE users SET active=?,can_create=? WHERE id=?').run(Number(b.active ?? target.active),Number(grant.can_create),target.id);
        db.prepare('DELETE FROM grants WHERE user_id=?').run(target.id);
        for (const app of new Set(grant.apps)) db.prepare('INSERT INTO grants VALUES (?,?)').run(target.id,app);
        // Revocar permisos de una rama nunca deja permisos huérfanos en sus descendientes.
        const cascade = (parentId, allowedApps, disable) => { for (const child of users.filter(u => u.parent_id === parentId)) { const apps = child.apps.filter(id => allowedApps.includes(id)); for (const id of child.apps.filter(id => !apps.includes(id))) db.prepare('DELETE FROM grants WHERE user_id=? AND app_id=?').run(child.id,id); if (disable) db.prepare('UPDATE users SET active=0 WHERE id=?').run(child.id); if (!grant.can_create) db.prepare('UPDATE users SET can_create=0 WHERE id=?').run(child.id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(child.id); cascade(child.id,apps,disable); } };
        const inheritedApps = target.role === 'superadmin' ? db.prepare('SELECT id FROM apps').all().map(app => app.id) : grant.apps;
        cascade(target.id,inheritedApps,b.active === false); db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id); log(actor,'Actualizó permisos y estado',target.name);
      });
      return send(200,{ok:true});
    }
    if (url.pathname === '/api/apps' && req.method === 'POST') {
      if (actor.role !== 'superadmin') fail(403,'Solo el superadministrador puede registrar aplicaciones.');
      if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 80 || typeof b.description !== 'string' || b.description.length > 250) fail(400,'Revisá el nombre y la descripción.');
      let target; try { target = new URL(b.url); } catch { fail(400,'Ingresá una URL válida.'); }
      if (!['http:','https:'].includes(target.protocol) || target.username || target.password) fail(400,'La dirección debe ser HTTP o HTTPS, sin credenciales.');
      const id=randomUUID(); transaction(() => { db.prepare('INSERT INTO apps VALUES (?,?,?,?,?)').run(id,b.name.trim(),b.description.trim(),target.href,'teal'); log(actor,'Registró una aplicación',b.name.trim()); }); return send(201,{ok:true});
    }
    if (/^\/api\/apps\/[^/]+\/launch$/.test(url.pathname) && req.method === 'GET') {
      const id=url.pathname.split('/')[3]; const app=db.prepare('SELECT * FROM apps WHERE id=?').get(id);
      if (!app || (actor.role !== 'superadmin' && !actor.apps.includes(id))) fail(403,'No tenés acceso a esta aplicación.');
      log(actor,'Abrió una aplicación',app.name); return send(200,{url:app.url});
    }
    fail(404,'No encontrado.');
  } catch (e) { if (!e.status) console.error(e); send(e.status || 500, {error:e.status ? e.message : 'No se pudo completar la operación.'}); }
});
const host=process.env.HOST || '127.0.0.1';
server.listen(Number(process.env.PORT || 3100),host,() => console.log(`AITUE disponible en http://${host}:${server.address().port}`));
