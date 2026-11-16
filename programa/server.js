'use strict';
/*
 * Sistema del Restaurante - servidor local
 * Funciona sin internet. Guarda todo en datos/restaurante.db (SQLite)
 * y hace respaldos automaticos en la carpeta respaldos/.
 * Requiere Node.js 22.13 o superior (https://nodejs.org).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');

const VERSION = '1.6.1';
const REPO_ACTUALIZACIONES = 'jonavarela0525-cell/sistema-restaurante'; // usuario/repositorio en GitHub
const BASE = __dirname;
const DATA_DIR = path.join(BASE, 'datos');
const BK_DIR = path.join(BASE, 'respaldos');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BK_DIR, { recursive: true });

const CFG_FILE = path.join(BASE, 'config.json');
let CFG = { puerto: 8080, carpetaRespaldoExtra: '', respaldosAGuardar: 60, horasEntreRespaldos: 2, actualizacionesAutomaticas: true, repoActualizaciones: '' };
try { Object.assign(CFG, JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))); } catch (e) {
  try { fs.writeFileSync(CFG_FILE, JSON.stringify(CFG, null, 2)); } catch (_) {}
}

const LOG_FILE = path.join(DATA_DIR, 'registro.log');
function log(...a) {
  const line = new Date().toISOString() + ' ' + a.join(' ');
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

/* ---------------- base de datos ---------------- */
// ¿hay un respaldo para restaurar? (se pidió desde el sistema; se cambia antes de abrir la base)
(function aplicarRestauracion() {
  const nuevo = path.join(DATA_DIR, 'restaurante_restaurar.db');
  if (!fs.existsSync(nuevo)) return;
  const actual = path.join(DATA_DIR, 'restaurante.db');
  const d = new Date(); const z = n => String(n).padStart(2, '0');
  const sello = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
  try {
    for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(actual + ext)) fs.renameSync(actual + ext, path.join(DATA_DIR, `restaurante_antes_de_restaurar_${sello}.db${ext}`));
    fs.renameSync(nuevo, actual);
    log('Respaldo restaurado. La base anterior quedó como restaurante_antes_de_restaurar_' + sello + '.db');
  } catch (e) { log('ERROR al restaurar el respaldo: ' + e.message); }
})();
const db = new DatabaseSync(path.join(DATA_DIR, 'restaurante.db'));
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS docs(path TEXT PRIMARY KEY, col TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_docs_col ON docs(col);
CREATE INDEX IF NOT EXISTS ix_docs_dia ON docs(col, json_extract(data,'$.dia'));
CREATE TABLE IF NOT EXISTS sesiones(token TEXT PRIMARY KEY, uid TEXT NOT NULL, creada INTEGER NOT NULL);
`);
const st = {
  get: db.prepare('SELECT data FROM docs WHERE path=?'),
  put: db.prepare('INSERT INTO docs(path,col,data,updated) VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data, updated=excluded.updated'),
  del: db.prepare('DELETE FROM docs WHERE path=?'),
  col: db.prepare('SELECT path,data FROM docs WHERE col=?'),
  count: db.prepare('SELECT COUNT(*) n FROM docs'),
  ses: db.prepare('SELECT uid FROM sesiones WHERE token=?'),
  sesAdd: db.prepare('INSERT INTO sesiones(token,uid,creada) VALUES(?,?,?)'),
  sesDel: db.prepare('DELETE FROM sesiones WHERE token=?'),
  sesDelUid: db.prepare('DELETE FROM sesiones WHERE uid=?'),
};
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
}
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
function parsePath(p, wantDoc) {
  if (typeof p !== 'string') throw err(400, 'Ruta inválida');
  const segs = p.split('/');
  if (!segs.every(s => SEG.test(s) && s !== '.' && s !== '..') || segs.length > 16) throw err(400, 'Ruta inválida');
  if (wantDoc && segs.length % 2 !== 0) throw err(400, 'Se esperaba un documento');
  if (!wantDoc && segs.length % 2 !== 1) throw err(400, 'Se esperaba una colección');
  return segs;
}
const colOf = p => p.split('/').slice(0, -1).join('/');
function readDoc(p) { const r = st.get.get(p); return r ? JSON.parse(r.data) : null; }
function writeDoc(p, data) { st.put.run(p, colOf(p), JSON.stringify(data), Date.now()); }
function err(code, msg) { const e = new Error(msg); e.status = code; return e; }
function isObj(o) { return o && typeof o === 'object' && !Array.isArray(o); }
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  return out;
}

/* ---------------- usuarios ---------------- */
function normUsuario(u) { return String(u || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '').toLowerCase().replace(/[^a-z0-9._-]/g, ''); }
function validar(nombre, usuario, pin, pinObligatorio) {
  if (!nombre) throw err(400, 'Escribe el nombre de la persona');
  if (usuario.length < 2) throw err(400, 'El usuario debe tener al menos 2 letras o números');
  if (usuario.length > 30) throw err(400, 'El usuario es muy largo (máximo 30)');
  if ((pinObligatorio || pin) && !/^\d{4,8}$/.test(String(pin || ''))) throw err(400, 'El PIN debe tener solo números, de 4 a 8 dígitos');
}
function hashPin(pin, salt) { return crypto.scryptSync(String(pin), salt, 32).toString('hex'); }
function usuarios() { return st.col.all('usuarios').map(r => ({ id: r.path.split('/')[1], ...JSON.parse(r.data) })); }
function publicUser(u) { return { id: u.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol, activo: u.activo !== false }; }
const fallos = new Map();
function sessionUser(req) {
  const t = req.headers['x-token'] || new URL(req.url, 'http://x').searchParams.get('t');
  if (!t) return null;
  const s = st.ses.get(String(t));
  if (!s) return null;
  const u = readDoc('usuarios/' + s.uid);
  if (!u || u.activo === false) return null;
  return { id: s.uid, ...u, token: String(t) };
}
const isAdmin = u => u && u.rol === 'admin';

/* ---------------- reglas de acceso ---------------- */
const soloClaves = (obj, permitidas) => Object.keys(obj || {}).every(k => permitidas.includes(k));
function checkRead(u, p) {
  const top = p.split('/')[0];
  if (top === 'usuarios' || top === 'sesiones') throw err(403, 'No permitido');
  if (top === 'cierres' && !isAdmin(u)) throw err(403, 'Solo el administrador');
}
function checkWrite(u, op, p, data, existe) {
  const top = p.split('/')[0];
  if (top === 'usuarios' || top === 'sesiones') throw err(403, 'No permitido');
  if (isAdmin(u)) return;
  const NO = () => { throw err(403, 'Solo el administrador puede hacer este cambio'); };
  switch (top) {
    case 'config': NO(); break; // el correlativo solo se toca con /api/siguiente
    case 'platos': case 'cierres': NO(); break;
    case 'insumos': NO(); break; // el stock se mueve con /api/stock
    case 'mesas': if (op !== 'update' || !soloClaves(data, ['items', 'abiertaEn', 'mesero', 'enviados'])) NO(); break;
    case 'facturas':
      if (op === 'set' && !existe) return;
      if (op === 'update' && soloClaves(data, ['saldo', 'creditoPendiente', 'pagadoEn'])) return;
      NO(); break;
    case 'abonos': case 'impresiones': if (op === 'set' && !existe) return; NO(); break;
    default: NO();
  }
}

/* ---------------- tiempo real (SSE) ---------------- */
const clientes = new Set();
function emitir(cols) {
  const msg = 'data: ' + JSON.stringify({ cols: [...new Set(cols)] }) + '\n\n';
  for (const c of clientes) { try { c.write(msg); } catch (_) {} }
}
setInterval(() => { for (const c of clientes) { try { c.write(': ping\n\n'); } catch (_) {} } }, 25000);

/* ---------------- consultas ---------------- */
const OPS = { '==': '=', '!=': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=' };
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,60}$/;
function sqlVal(v) { return typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v; }
function query(col, filters, orderBy, limit) {
  let sql = 'SELECT path,data FROM docs WHERE col=?';
  const args = [col];
  for (const [f, op, v] of filters || []) {
    if (!FIELD.test(f) || !(op in OPS || op === 'in')) throw err(400, 'Filtro inválido');
    if (op === 'in') {
      if (!Array.isArray(v) || !v.length || v.length > 30) throw err(400, 'Filtro inválido');
      sql += ` AND json_extract(data,'$.${f}') IN (${v.map(() => '?').join(',')})`; args.push(...v.map(sqlVal));
    } else if (v === null) {
      sql += ` AND json_extract(data,'$.${f}') IS ${op === '!=' ? 'NOT ' : ''}NULL`;
    } else { sql += ` AND json_extract(data,'$.${f}') ${OPS[op]} ?`; args.push(sqlVal(v)); }
  }
  if (orderBy) {
    const [f, dir] = orderBy;
    if (!FIELD.test(f)) throw err(400, 'Orden inválido');
    sql += ` ORDER BY json_extract(data,'$.${f}') ${dir === 'desc' ? 'DESC' : 'ASC'}`;
  } else sql += ' ORDER BY path';
  const lim = Math.min(Math.max(parseInt(limit) || 5000, 1), 20000);
  sql += ' LIMIT ' + lim;
  return db.prepare(sql).all(...args).map(r => ({ id: r.path.split('/').pop(), data: JSON.parse(r.data) }));
}

/* ---------------- respaldos ---------------- */
function stamp() { const d = new Date(); const z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`; }
function respaldo(motivo) {
  try {
    const nombre = `restaurante_${stamp()}.db`;
    const destino = path.join(BK_DIR, nombre);
    db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
    if (CFG.carpetaRespaldoExtra) {
      try { fs.mkdirSync(CFG.carpetaRespaldoExtra, { recursive: true }); fs.copyFileSync(destino, path.join(CFG.carpetaRespaldoExtra, nombre)); }
      catch (e) { log('No se pudo copiar el respaldo a', CFG.carpetaRespaldoExtra, e.message); }
    }
    const files = fs.readdirSync(BK_DIR).filter(f => /^restaurante_.*\.db$/.test(f)).sort();
    const keep = Math.max(5, CFG.respaldosAGuardar | 0);
    for (const f of files.slice(0, Math.max(0, files.length - keep))) { try { fs.unlinkSync(path.join(BK_DIR, f)); } catch (_) {} }
    log('Respaldo creado (' + motivo + '):', nombre);
    return nombre;
  } catch (e) { log('ERROR al respaldar:', e.message); return null; }
}

/* ---------------- importación inicial ---------------- */
function importarSiVacia() {
  const f = path.join(BASE, 'importar.json');
  if (!fs.existsSync(f)) return;
  const n = st.count.get().n;
  if (n > 0) return;
  try {
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    tx(() => { for (const [p, d] of Object.entries(data.docs || {})) { parsePath(p, true); writeDoc(p, d); } });
    fs.renameSync(f, path.join(BASE, 'importar_hecho_' + stamp() + '.json'));
    log('Datos importados:', Object.keys(data.docs || {}).length, 'documentos');
  } catch (e) { log('ERROR al importar:', e.message); }
}

/* ---------------- http ---------------- */
function bodyCrudo(req, max) {
  return new Promise((res, rej) => {
    const partes = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > max) { rej(err(413, 'El archivo es demasiado grande')); req.destroy(); } else partes.push(c); });
    req.on('end', () => res(Buffer.concat(partes))); req.on('error', rej);
  });
}
function body(req) {
  return new Promise((res, rej) => {
    let b = ''; req.setEncoding('utf8');
    req.on('data', c => { b += c; if (b.length > 5e6) { rej(err(413, 'Demasiado grande')); req.destroy(); } });
    req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { rej(err(400, 'JSON inválido')); } });
  });
}
function send(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}
function ips() {
  const out = [];
  for (const arr of Object.values(os.networkInterfaces())) for (const i of arr || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}

async function api(req, res, url) {
  const route = url.pathname.slice(5);
  if (route === 'estado') {
    const hayUsuarios = usuarios().length > 0;
    const u = sessionUser(req);
    return send(res, 200, { version: VERSION, hayUsuarios, yo: u ? publicUser(u) : null, ips: ips(), puerto: CFG.puerto, ahora: Date.now() });
  }
  if (route === 'restaurar' && req.method === 'POST') {
    const sinUsuarios = usuarios().length === 0;
    if (!sinUsuarios && !isAdmin(sessionUser(req))) throw err(403, 'Solo el administrador puede restaurar un respaldo');
    const buf = await bodyCrudo(req, 500 * 1024 * 1024);
    if (buf.length < 100 || buf.subarray(0, 16).toString('latin1') !== 'SQLite format 3\u0000') throw err(400, 'Ese archivo no es un respaldo del sistema (debe ser un archivo restaurante_....db)');
    const tmp = path.join(DATA_DIR, 'restaurante_restaurar.tmp');
    fs.writeFileSync(tmp, buf);
    let info;
    try {
      const t = new DatabaseSync(tmp, { readOnly: true });
      const tabla = t.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='docs'").get();
      if (!tabla) { t.close(); throw err(400, 'Ese archivo no es un respaldo del sistema'); }
      const cuenta = col => t.prepare('SELECT COUNT(*) n FROM docs WHERE col=?').get(col).n;
      info = { usuarios: cuenta('usuarios'), facturas: cuenta('facturas'), platos: cuenta('platos'), insumos: cuenta('insumos') };
      t.close();
    } catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} if (e.status) throw e; throw err(400, 'El respaldo está dañado o no se puede leer'); }
    respaldo('antes de restaurar un respaldo');
    fs.renameSync(tmp, path.join(DATA_DIR, 'restaurante_restaurar.db'));
    log(`Restauración solicitada: ${info.facturas} facturas, ${info.platos} platos, ${info.usuarios} usuarios. Reiniciando...`);
    send(res, 200, { ok: true, ...info, reinicioAutomatico: !!process.env.RS_LANZADOR });
    setTimeout(() => { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch (_) {} process.exit(75); }, 700);
    return;
  }
  if (route === 'configurar' && req.method === 'POST') {
    const b = await body(req);
    return tx(() => {
      if (usuarios().length) throw err(400, 'El sistema ya está configurado');
      const nombre = String(b.nombre || '').trim(), usuario = normUsuario(b.usuario), pin = String(b.pin || '').trim();
      validar(nombre, usuario, pin, true);
      const id = crypto.randomUUID().slice(0, 12), salt = crypto.randomBytes(16).toString('hex');
      writeDoc('usuarios/' + id, { nombre, usuario, rol: 'admin', activo: true, salt, pinHash: hashPin(pin, salt), creado: new Date().toISOString() });
      const token = crypto.randomBytes(24).toString('hex'); st.sesAdd.run(token, id, Date.now());
      log('Administrador creado:', usuario);
      send(res, 200, { token, yo: { id, nombre, usuario, rol: 'admin', activo: true } });
    });
  }
  if (route === 'entrar' && req.method === 'POST') {
    const b = await body(req);
    const usuario = normUsuario(b.usuario);
    const f = fallos.get(usuario) || { n: 0, hasta: 0 };
    if (f.hasta > Date.now()) throw err(429, 'Demasiados intentos. Espera un minuto.');
    const u = usuarios().find(x => x.usuario === usuario && x.activo !== false);
    if (!u || hashPin(String(b.pin || '').trim(), u.salt) !== u.pinHash) {
      f.n++; if (f.n >= 5) { f.hasta = Date.now() + 60000; f.n = 0; } fallos.set(usuario, f);
      throw err(401, 'Usuario o PIN incorrecto');
    }
    fallos.delete(usuario);
    const token = crypto.randomBytes(24).toString('hex'); st.sesAdd.run(token, u.id, Date.now());
    log('Inicio de sesión:', usuario);
    return send(res, 200, { token, yo: publicUser(u) });
  }

  const u = sessionUser(req);
  if (!u) throw err(401, 'Sesión no válida');

  if (route === 'salir' && req.method === 'POST') { st.sesDel.run(u.token); return send(res, 200, { ok: true }); }
  if (route === 'eventos') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clientes.add(res); req.on('close', () => clientes.delete(res));
    return;
  }
  if (route === 'usuarios' && req.method === 'GET') return send(res, 200, { usuarios: usuarios().map(publicUser) });
  if (route === 'usuarios' && req.method === 'POST') {
    if (!isAdmin(u)) throw err(403, 'Solo el administrador');
    const b = await body(req);
    return tx(() => {
      const lista = usuarios();
      const id = b.id || crypto.randomUUID().slice(0, 12);
      const prev = lista.find(x => x.id === id);
      const nombre = String(b.nombre ?? prev?.nombre ?? '').trim();
      const usuario = normUsuario(b.usuario ?? prev?.usuario ?? '');
      const rol = b.rol === 'admin' ? 'admin' : 'usuario';
      const activo = b.activo !== false;
      validar(nombre, usuario, b.pin, !prev);
      if (lista.some(x => x.usuario === usuario && x.id !== id)) throw err(400, 'Ese nombre de usuario ya existe');
      if (prev && prev.rol === 'admin' && (rol !== 'admin' || !activo) && lista.filter(x => x.rol === 'admin' && x.activo !== false).length <= 1) throw err(400, 'Debe quedar al menos un administrador activo');
      const doc = { ...(prev || {}), nombre, usuario, rol, activo };
      delete doc.id;
      if (b.pin) { b.pin = String(b.pin).trim(); doc.salt = crypto.randomBytes(16).toString('hex'); doc.pinHash = hashPin(b.pin, doc.salt); }
      if (!prev) doc.creado = new Date().toISOString();
      writeDoc('usuarios/' + id, doc);
      if (!activo || b.pin) st.sesDelUid.run(id);
      log('Usuario guardado por', u.usuario + ':', usuario, rol, activo ? 'activo' : 'inactivo');
      send(res, 200, { ok: true, id });
    });
  }
  if (route === 'op' && req.method === 'POST') {
    const b = await body(req);
    const { op } = b;
    if (op === 'get') {
      parsePath(b.path, true); checkRead(u, b.path);
      const d = readDoc(b.path); return send(res, 200, { exists: !!d, data: d });
    }
    if (op === 'query') {
      parsePath(b.col, false); checkRead(u, b.col + '/x');
      return send(res, 200, { docs: query(b.col, b.filters, b.orderBy, b.limit) });
    }
    if (op === 'set' || op === 'update' || op === 'delete') {
      parsePath(b.path, true);
      if (op !== 'delete' && !isObj(b.data)) throw err(400, 'Datos inválidos');
      const r = tx(() => {
        const cur = readDoc(b.path);
        checkWrite(u, op, b.path, b.data, !!cur);
        if (op === 'set') writeDoc(b.path, b.data);
        else if (op === 'update') {
          if (!cur) throw err(400, 'El documento no existe');
          const nuevo = deepMerge(cur, b.data);
          if (b.path.startsWith('mesas/') && 'enviados' in b.data && b.data.enviados === null) nuevo.enviados = {};
          if (b.path.startsWith('mesas/') && 'items' in b.data) nuevo.ultimoCambio = Date.now();
          writeDoc(b.path, nuevo);
        }
        else st.del.run(b.path);
        return true;
      });
      ultimaEscritura = Date.now();
      emitir([colOf(b.path)]);
      return send(res, 200, { ok: r });
    }
    throw err(400, 'Operación desconocida');
  }
  if (route === 'stock' && req.method === 'POST') {
    // movimientos de inventario atómicos: [{id, delta}] ; usuarios solo pueden descontar/devolver por ventas
    const b = await body(req);
    const movs = Array.isArray(b.movs) ? b.movs : [];
    if (!isAdmin(u) && !['venta', 'anulacion'].includes(b.motivo)) throw err(403, 'Solo el administrador');
    if (b.motivo === 'anulacion' && !isAdmin(u)) throw err(403, 'Solo el administrador');
    tx(() => {
      for (const m of movs) {
        const p = 'insumos/' + m.id; parsePath(p, true);
        const cur = readDoc(p); if (!cur) continue;
        const d = Number(m.delta); if (!isFinite(d)) throw err(400, 'Cantidad inválida');
        if (!isAdmin(u) && d > 0) throw err(403, 'No permitido');
        const upd = { ...cur, stock: Math.round((Number(cur.stock || 0) + d) * 1000) / 1000 };
        if (isAdmin(u) && m.costo != null && isFinite(Number(m.costo))) upd.costo = Number(m.costo);
        writeDoc(p, upd);
      }
    });
    emitir(['insumos']);
    return send(res, 200, { ok: true });
  }
  if (route === 'siguiente' && req.method === 'POST') {
    const b = await body(req);
    const n = tx(() => {
      const neg = readDoc('config/negocio') || {};
      const cor = readDoc('config/correlativo') || {};
      const conCAI = !!(neg.cai && neg.rangoDesde && neg.rangoHasta);
      if (b.fiscal !== conCAI) throw err(409, 'Los datos de facturación cambiaron. Intenta de nuevo.');
      let next;
      if (conCAI) {
        const desde = Math.floor(Number(neg.rangoDesde)), hasta = Math.floor(Number(neg.rangoHasta));
        next = Math.floor(Number(cor.siguiente)) || 0;
        if (!next || next < desde || cor.cai !== neg.cai) next = desde;
        if (next > hasta) throw err(400, 'Se agotó el rango autorizado. Solicita un nuevo CAI al SAR y actualízalo en Ajustes.');
        writeDoc('config/correlativo', { ...cor, siguiente: next + 1, cai: neg.cai });
      } else {
        next = Math.floor(Number(cor.siguienteInterno)) || 1;
        writeDoc('config/correlativo', { ...cor, siguienteInterno: next + 1 });
      }
      return next;
    });
    emitir(['config']);
    return send(res, 200, { numero: n });
  }
  if (route === 'comanda' && req.method === 'POST') {
    // genera la comanda de cocina con lo pendiente de una mesa (atómico: nunca se manda dos veces lo mismo)
    const b = await body(req); const p = 'mesas/' + String(b.mesaId || ''); parsePath(p, true);
    const r = tx(() => {
      const m = readDoc(p); if (!m) return null;
      const env = m.enviados || {}; const lineas = []; const nuevoEnv = {}; const vistos = new Set();
      for (const it of m.items || []) {
        if (it.cocina === false || !it.k) continue;
        vistos.add(it.k);
        const prev = env[it.k] || { c: 0, n: it.nombre, nota: '' };
        const d = Number(it.cant) - Number(prev.c || 0);
        if (d !== 0) lineas.push({ nombre: it.nombre, cant: d, nota: it.nota || '' });
        else if ((prev.nota || '') !== (it.nota || '') && prev.c > 0) lineas.push({ nombre: it.nombre, cant: 0, nota: it.nota || '', cambioNota: true });
        nuevoEnv[it.k] = { c: Number(it.cant), n: it.nombre, nota: it.nota || '' };
      }
      for (const [k, v] of Object.entries(env)) if (!vistos.has(k) && v && v.c > 0) lineas.push({ nombre: v.n, cant: -v.c, nota: '' });
      if (!lineas.length) { if (JSON.stringify(env) !== JSON.stringify(nuevoEnv)) writeDoc(p, { ...m, enviados: nuevoEnv }); return null; }
      writeDoc(p, { ...m, enviados: nuevoEnv });
      const ahora = new Date(); const z = n => String(n).padStart(2, '0'); const dia = `${ahora.getFullYear()}-${z(ahora.getMonth() + 1)}-${z(ahora.getDate())}`;
      const cont = readDoc('config/comandas') || {}; const numero = cont.dia === dia ? (cont.n || 0) + 1 : 1;
      writeDoc('config/comandas', { dia, n: numero });
      const mu = m.mesero ? readDoc('usuarios/' + m.mesero) : null;
      const comanda = { numero, mesa: m.nombre, mesero: (mu && mu.nombre) || u.nombre, hora: ahora.toISOString(), lineas };
      writeDoc('impresiones/' + crypto.randomUUID().slice(0, 16), { tipo: 'comanda', comanda, estado: 'pendiente', creado: ahora.toISOString(), por: u.id });
      return comanda;
    });
    emitir(['mesas', 'impresiones', 'config']);
    return send(res, 200, { ok: !!r, comanda: r });
  }
  if (route === 'tomarImpresion' && req.method === 'POST') {
    const b = await body(req); const p = 'impresiones/' + String(b.id || ''); parsePath(p, true);
    const ok = tx(() => {
      const d = readDoc(p); if (!d || d.estado !== 'pendiente') return false;
      const viejo = Date.now() - new Date(d.creado).getTime() > 20 * 60000;
      writeDoc(p, { ...d, estado: viejo ? 'omitida' : 'impreso', impresoEn: new Date().toISOString(), impresoPor: u.id });
      return !viejo;
    });
    emitir(['impresiones']);
    return send(res, 200, { ok });
  }
  if (route === 'actualizacion') {
    if (!isAdmin(u)) throw err(403, 'Solo el administrador');
    if (req.method === 'POST') {
      const b = await body(req);
      if (b.accion === 'revisar') { await revisarActualizacion(true); }
      else if (b.accion === 'instalar') { aplicarActualizacion(true); }
    }
    return send(res, 200, { version: VERSION, repo: repoAct(), automatico: CFG.actualizacionesAutomaticas !== false, lanzador: !!process.env.RS_LANZADOR, ...UPD });
  }
  if (route === 'respaldo' && req.method === 'POST') {
    if (!isAdmin(u)) throw err(403, 'Solo el administrador');
    const nombre = respaldo('manual'); if (!nombre) throw err(500, 'No se pudo crear el respaldo');
    return send(res, 200, { nombre, carpeta: BK_DIR });
  }
  if (route === 'respaldos' && req.method === 'GET') {
    if (!isAdmin(u)) throw err(403, 'Solo el administrador');
    const files = fs.readdirSync(BK_DIR).filter(f => /^restaurante_.*\.db$/.test(f)).sort().reverse()
      .map(f => ({ nombre: f, bytes: fs.statSync(path.join(BK_DIR, f)).size }));
    return send(res, 200, { carpeta: BK_DIR, extra: CFG.carpetaRespaldoExtra || '', archivos: files.slice(0, 20), total: files.length });
  }
  if (route === 'descargarRespaldo' && req.method === 'GET') {
    if (!isAdmin(u)) throw err(403, 'Solo el administrador');
    const nombre = respaldo('descarga'); if (!nombre) throw err(500, 'No se pudo crear el respaldo');
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${nombre}"` });
    return fs.createReadStream(path.join(BK_DIR, nombre)).pipe(res);
  }
  if (route === 'exportar' && req.method === 'GET') {
    if (!isAdmin(u)) throw err(403, 'Solo el administrador');
    const docs = {};
    for (const r of db.prepare("SELECT path,data FROM docs WHERE col NOT IN ('usuarios')").all()) docs[r.path] = JSON.parse(r.data);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="respaldo_restaurante_${stamp()}.json"` });
    return res.end(JSON.stringify({ version: VERSION, exportado: new Date().toISOString(), docs }));
  }
  throw err(404, 'No encontrado');
}

const APP = path.join(BASE, 'app.html');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(APP).pipe(res);
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    res.writeHead(404); res.end('No encontrado');
  } catch (e) {
    const code = e.status || 500;
    if (code === 500) log('ERROR', req.method, url.pathname, e.stack || e.message);
    if (!res.headersSent) send(res, code, { error: e.message || 'Error' });
  }
});

/* ---------------- actualizaciones automáticas ---------------- */
const crypto2 = crypto; const { spawnSync } = require('child_process');
const PEND = path.join(BASE, 'actualizacion_pendiente');
const ANT = path.join(BASE, 'version_anterior');
const UPD = { estado: 'sin revisar', ultimaRevision: null, disponible: null, error: null };
let ultimaEscritura = 0;
const repoAct = () => String(CFG.repoActualizaciones || REPO_ACTUALIZACIONES || '').replace(/^__REPO__$/, '');
const PROTEGIDOS = new Set(['config.json', 'importar.json']);
const NOMBRE_OK = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,80}\.(js|html|vbs|ps1|bat|txt|md)$/;
function cmpVer(a, b) { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; }
function hayActividad() {
  if (Date.now() - ultimaEscritura < 3 * 60000) return true;
  return st.col.all('mesas').some(r => (JSON.parse(r.data).items || []).length > 0);
}
let revisando = false;
async function revisarActualizacion(manual) {
  const repo = repoAct();
  if (!repo) { UPD.estado = 'no configurado'; return; }
  if (revisando) return; revisando = true;
  try {
    const base = process.env.RS_UPD_BASE || `https://raw.githubusercontent.com/${repo}/main/`;
    const r = await fetch(base + 'version.json?t=' + Date.now(), { signal: AbortSignal.timeout(20000), cache: 'no-store' });
    if (!r.ok) throw new Error('No se pudo leer la versión publicada (' + r.status + ')');
    const man = await r.json();
    UPD.ultimaRevision = new Date().toISOString(); UPD.error = null;
    if (!man.version || cmpVer(man.version, VERSION) <= 0) { UPD.estado = 'al día'; UPD.disponible = null; return; }
    const fallidas = fs.readdirSync(DATA_DIR).filter(f => /^actualizacion_fallida_\d+\.json$/.test(f)).map(f => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')).a; } catch (_) { return null; } });
    if (fallidas.includes(man.version)) { UPD.estado = `la versión ${man.version} falló al iniciar y se omitió; esperando una versión más nueva`; UPD.disponible = null; return; }
    // ¿ya está descargada?
    try { const p = JSON.parse(fs.readFileSync(path.join(PEND, 'version.json'), 'utf8')); if (p.version === man.version) { UPD.disponible = man.version; aplicarActualizacion(false); return; } } catch (_) {}
    UPD.estado = 'descargando ' + man.version;
    const tmp = PEND + '_tmp'; fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
    for (const f of man.archivos || []) {
      if (!NOMBRE_OK.test(f.nombre) || PROTEGIDOS.has(f.nombre)) throw new Error('Archivo no permitido en la actualización: ' + f.nombre);
      const rr = await fetch(base + 'programa/' + encodeURIComponent(f.nombre) + '?t=' + Date.now(), { signal: AbortSignal.timeout(60000), cache: 'no-store' });
      if (!rr.ok) throw new Error('No se pudo descargar ' + f.nombre);
      const buf = Buffer.from(await rr.arrayBuffer());
      const h = crypto2.createHash('sha256').update(buf).digest('hex');
      if (h !== f.sha256) throw new Error('El archivo ' + f.nombre + ' llegó dañado');
      fs.writeFileSync(path.join(tmp, f.nombre), buf);
    }
    for (const js of ['server.js', 'lanzador.js']) {
      const fp = path.join(tmp, js);
      if (fs.existsSync(fp) && spawnSync(process.execPath, ['--check', fp]).status !== 0) throw new Error('La versión nueva tiene un error (' + js + '); no se instala');
    }
    fs.writeFileSync(path.join(tmp, 'version.json'), JSON.stringify(man));
    fs.rmSync(PEND, { recursive: true, force: true }); fs.renameSync(tmp, PEND);
    UPD.disponible = man.version; log('Actualización ' + man.version + ' descargada.');
    aplicarActualizacion(false);
  } catch (e) {
    UPD.error = e.name === 'TimeoutError' || /fetch failed/i.test(e.message) ? 'Sin internet; se intentará más tarde' : e.message;
    UPD.estado = 'error'; if (manual) log('Actualización: ' + UPD.error);
  } finally { revisando = false; }
}
function aplicarActualizacion(forzar) {
  let man; try { man = JSON.parse(fs.readFileSync(path.join(PEND, 'version.json'), 'utf8')); } catch (_) { return false; }
  if (cmpVer(man.version, VERSION) <= 0) { fs.rmSync(PEND, { recursive: true, force: true }); return false; }
  if (!process.env.RS_LANZADOR) { UPD.estado = 'lista: se instalará al reiniciar la computadora'; return false; }
  if (!forzar && hayActividad()) { UPD.estado = `versión ${man.version} lista: se instalará cuando no haya mesas abiertas`; return false; }
  try {
    respaldo('antes de actualizar a ' + man.version);
    fs.rmSync(ANT, { recursive: true, force: true }); fs.mkdirSync(ANT);
    for (const f of man.archivos) { const actual = path.join(BASE, f.nombre); if (fs.existsSync(actual)) fs.copyFileSync(actual, path.join(ANT, f.nombre)); }
    for (const f of man.archivos) fs.copyFileSync(path.join(PEND, f.nombre), path.join(BASE, f.nombre));
    fs.writeFileSync(path.join(DATA_DIR, 'actualizacion_reciente.json'), JSON.stringify({ de: VERSION, a: man.version, fecha: new Date().toISOString() }));
    fs.rmSync(PEND, { recursive: true, force: true });
    log(`Actualizado de ${VERSION} a ${man.version}. Reiniciando...`);
    UPD.estado = 'instalando ' + man.version;
    emitir(['__actualizacion']);
    setTimeout(() => { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch (_) {} process.exit(75); }, 800);
    return true;
  } catch (e) { UPD.estado = 'error'; UPD.error = 'No se pudo instalar: ' + e.message; log(UPD.error); return false; }
}

importarSiVacia();
try { db.prepare("DELETE FROM docs WHERE col='impresiones' AND updated < ?").run(Date.now() - 2 * 86400000); } catch (_) {}
server.on('error', e => {
  if (e.code === 'EADDRINUSE') { log('El sistema ya está funcionando en el puerto', CFG.puerto); process.exit(0); }
  log('ERROR del servidor:', e.message); process.exit(1);
});
server.listen(CFG.puerto, '0.0.0.0', () => {
  log(`Sistema del Restaurante v${VERSION} funcionando.`);
  log(`En esta computadora: http://localhost:${CFG.puerto}`);
  for (const ip of ips()) log(`Desde celulares (mismo WiFi): http://${ip}:${CFG.puerto}`);
  respaldo('inicio');
  if (CFG.actualizacionesAutomaticas !== false) {
    setTimeout(() => revisarActualizacion(false), 60 * 1000);
    setInterval(() => revisarActualizacion(false), 60 * 60 * 1000);
    setInterval(() => { if (UPD.disponible) aplicarActualizacion(false); }, 2 * 60 * 1000);
  }
  setInterval(() => respaldo('automático'), Math.max(0.25, Number(CFG.horasEntreRespaldos) || 2) * 3600 * 1000);
});
function cerrar() { log('Cerrando el sistema...'); try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch (_) {} process.exit(0); }
process.on('SIGINT', cerrar); process.on('SIGTERM', cerrar);
