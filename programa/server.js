'use strict';
/*
 * Sistema del Restaurante - servidor local
 * Funciona sin internet. Guarda todo en datos/restaurante.db (SQLite)
 * y hace respaldos automaticos en la carpeta respaldos/.
 * Con internet, se sincroniza con las otras computadoras del restaurante
 * a través de un repositorio PRIVADO de GitHub (cada computadora sube sus cambios).
 * Requiere Node.js 22.13 o superior (https://nodejs.org).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');
const IMP = require('./impresion.js');

const VERSION = '2.4.1';
const REPO_ACTUALIZACIONES = 'jonavarela0525-cell/sistema-restaurante'; // usuario/repositorio en GitHub
const BASE = __dirname;
const DATA_DIR = path.join(BASE, 'datos');
const BK_DIR = path.join(BASE, 'respaldos');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BK_DIR, { recursive: true });

const CFG_FILE = path.join(BASE, 'config.json');
let CFG = { puerto: 8080, carpetaRespaldoExtra: '', respaldosAGuardar: 60, horasEntreRespaldos: 2, actualizacionesAutomaticas: true, repoActualizaciones: '',
  equipo: '', equipoId: '', facturaEnEsteEquipo: true, sync: { repo: '', token: '' }, impresora: { nombre: '', columnas: 48, acentos: true } };
try { Object.assign(CFG, JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))); } catch (e) {}
if (!CFG.sync || typeof CFG.sync !== 'object') CFG.sync = { repo: '', token: '' };
if (!CFG.impresora || typeof CFG.impresora !== 'object') CFG.impresora = { nombre: '', columnas: 48, acentos: true };
if (!CFG.equipo) CFG.equipo = os.hostname() || 'Computadora';
// identificador único de esta computadora (vive en config.json, no en la base: así un respaldo restaurado no lo copia)
if (!/^d[0-9a-f]{10}$/.test(String(CFG.equipoId || ''))) CFG.equipoId = 'd' + crypto.randomBytes(5).toString('hex');
function guardarCfg() { try { fs.writeFileSync(CFG_FILE, JSON.stringify(CFG, null, 2)); } catch (e) { console.log('No se pudo guardar config.json: ' + e.message); } }
guardarCfg();
const DEV = CFG.equipoId;

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
CREATE TABLE IF NOT EXISTS ops(id TEXT PRIMARY KEY, dev TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, path TEXT NOT NULL, op TEXT NOT NULL, data TEXT, dia TEXT NOT NULL, subido INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_ops_path ON ops(path, ts, dev, seq);
CREATE INDEX IF NOT EXISTS ix_ops_subir ON ops(dev, subido, dia);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS archivos(path TEXT PRIMARY KEY, sha TEXT NOT NULL);
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
  metaGet: db.prepare('SELECT v FROM meta WHERE k=?'),
  metaSet: db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v'),
  metaDel: db.prepare('DELETE FROM meta WHERE k=?'),
  opAdd: db.prepare('INSERT OR IGNORE INTO ops(id,dev,seq,ts,path,op,data,dia,subido) VALUES(?,?,?,?,?,?,?,?,?)'),
  opsPath: db.prepare('SELECT op,data FROM ops WHERE path=? ORDER BY ts,dev,seq'),
  opsDespues: db.prepare('SELECT 1 FROM ops WHERE path=? AND (ts>? OR (ts=? AND (dev>? OR (dev=? AND seq>?)))) LIMIT 1'),
  archGet: db.prepare('SELECT sha FROM archivos WHERE path=?'),
  archSet: db.prepare('INSERT INTO archivos(path,sha) VALUES(?,?) ON CONFLICT(path) DO UPDATE SET sha=excluded.sha'),
};
const meta = (k, d) => { const r = st.metaGet.get(k); return r ? r.v : d; };
const setMeta = (k, v) => st.metaSet.run(k, String(v));
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
function writeDoc(p, data) { st.put.run(p, colOf(p), JSON.stringify(data), Date.now()); } // solo para datos locales (impresiones)
function err(code, msg) { const e = new Error(msg); e.status = code; return e; }
function isObj(o) { return o && typeof o === 'object' && !Array.isArray(o); }
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  return out;
}
const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const r3 = n => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
function diaLocal(ts) { const d = new Date(ts); const z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; }

/* ------------- registro de cambios (para sincronizar) -------------
 * Cada escritura es una operación (set / update / delete) con fecha, equipo y número.
 * Todas las computadoras aplican las mismas operaciones en el mismo orden, así
 * llegan al mismo resultado aunque hayan trabajado sin internet al mismo tiempo.
 * El inventario se guarda como movimientos con nombre propio (movs) y los abonos
 * de crédito como un mapa (abonos): por eso nunca se pisan entre computadoras. */
const LOCALES = new Set(['impresiones']); // no se sincronizan
const esLocal = p => LOCALES.has(p.split('/')[0]);
function derivar(p, d) {
  if (!d) return d;
  const top = p.split('/')[0];
  if (top === 'mesas' && d.enviados === null) d.enviados = {};
  if (top === 'insumos') {
    if (isObj(d.movs)) d.stock = r3(Object.values(d.movs).reduce((a, v) => a + (Number(v) || 0), 0));
  }
  if (top === 'facturas' && d.metodo === 'Crédito') {
    const pagado = r2(Object.values(isObj(d.abonos) ? d.abonos : {}).reduce((a, v) => a + (Number(v) || 0), 0));
    d.saldo = d.anulada ? 0 : Math.max(0, r2(Number(d.totalPagar || 0) - pagado));
    d.creditoPendiente = !d.anulada && d.saldo > 0.004;
  }
  return d;
}
function aplicar(cur, op, data) {
  if (op === 'set') return data ? JSON.parse(JSON.stringify(data)) : null;
  if (op === 'update') return cur ? deepMerge(cur, data) : null; // actualizar algo que no existe: se ignora
  return null; // delete
}
function guardarDoc(p, d) { d = derivar(p, d); if (d) st.put.run(p, colOf(p), JSON.stringify(d), Date.now()); else st.del.run(p); }
function reconstruir(p) {
  let d = null;
  for (const o of st.opsPath.all(p)) d = aplicar(d, o.op, o.data ? JSON.parse(o.data) : null);
  guardarDoc(p, d);
}
let SEQ = Math.max(Number(meta('seq:' + DEV, '0')) || 0, Number((db.prepare('SELECT MAX(seq) m FROM ops WHERE dev=?').get(DEV) || {}).m) || 0);
function escribirLocal(op, p, data) {
  // debe llamarse dentro de tx()
  if (esLocal(p)) { if (op === 'delete') st.del.run(p); else writeDoc(p, op === 'update' ? deepMerge(readDoc(p) || {}, data) : data); return; }
  SEQ += 1; setMeta('seq:' + DEV, SEQ);
  let ts = Date.now();
  const ult = Number(meta('ultimoTs', '0')); if (ts <= ult) ts = ult + 1; setMeta('ultimoTs', ts);
  const json = op === 'delete' ? null : JSON.stringify(data);
  st.opAdd.run(DEV + ':' + SEQ, DEV, SEQ, ts, p, op, json, diaLocal(ts), 0);
  if (st.opsDespues.get(p, ts, ts, DEV, DEV, SEQ)) reconstruir(p);
  else guardarDoc(p, aplicar(readDoc(p), op, data));
  pedirSync(3000);
}
const movKey = pref => pref + DEV.slice(1, 6) + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');

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
  if (top === 'facturas' && op === 'update' && data && ('saldo' in data || 'creditoPendiente' in data)) throw err(400, 'El saldo se calcula solo con los abonos');
  if (isAdmin(u)) return;
  const NO = () => { throw err(403, 'Solo el administrador puede hacer este cambio'); };
  switch (top) {
    case 'config': NO(); break; // el correlativo solo se toca con /api/siguiente
    case 'platos': case 'cierres': NO(); break;
    case 'insumos': NO(); break; // el stock se mueve con /api/stock
    case 'mesas': if (op !== 'update' || !soloClaves(data, ['items', 'abiertaEn', 'mesero', 'enviados', 'cliente'])) NO(); break;
    case 'facturas':
      if (op === 'set' && !existe) return;
      if (op === 'update' && existe && soloClaves(data, ['abonos']) && isObj(data.abonos) && Object.values(data.abonos).every(v => Number(v) > 0)) return;
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

/* ---------------- migración v1 -> v2 (registro de cambios) ----------------
 * Convierte los datos existentes al formato que se puede sincronizar:
 * existencias -> movimientos, saldos de crédito -> abonos, correlativos -> por computadora. */
function prepararDoc(p, d, claveStock) {
  const top = p.split('/')[0];
  d = JSON.parse(JSON.stringify(d));
  if (top === 'insumos' && !isObj(d.movs)) { const s = Number(d.stock) || 0; d.movs = s ? { [claveStock]: r3(s) } : {}; }
  if (top === 'insumos') delete d.stock;
  if (top === 'facturas' && d.metodo === 'Crédito' && !isObj(d.abonos)) {
    const ab = {};
    for (const r of st.col.all('abonos')) { const a = JSON.parse(r.data); if (a.facturaId === p.split('/')[1]) ab[r.path.split('/')[1]] = r2(a.monto); }
    const sum = Object.values(ab).reduce((x, v) => x + v, 0);
    const falta = r2(Number(d.totalPagar || 0) - Number(d.saldo ?? d.totalPagar) - sum); // pagos sin registro de abono
    if (falta > 0.004 && !d.anulada) ab['previo'] = falta;
    d.abonos = ab;
  }
  if (top === 'facturas') { delete d.saldo; delete d.creditoPendiente; }
  return d;
}
function migrarV2() {
  if (meta('migradoV2')) return;
  const hayOps = db.prepare('SELECT 1 FROM ops LIMIT 1').get();
  const docs = db.prepare("SELECT path,data FROM docs WHERE col NOT IN ('impresiones') ORDER BY path").all();
  tx(() => {
    if (!hayOps && docs.length) {
      const cor = readDoc('config/correlativo') || {};
      if (cor.siguienteInterno) setMeta('cor:int', cor.siguienteInterno);
      if (cor.siguiente && cor.cai) setMeta('cor:cai:' + cor.cai, cor.siguiente);
      const com = readDoc('config/comandas'); if (com) setMeta('comandas', JSON.stringify(com));
      for (const r of docs) {
        if (r.path === 'config/correlativo' || r.path === 'config/comandas') { st.del.run(r.path); continue; }
        escribirLocal('set', r.path, prepararDoc(r.path, JSON.parse(r.data), 'ini' + DEV.slice(1, 6)));
      }
      log('Datos convertidos al formato sincronizable:', docs.length, 'documentos');
    }
    setMeta('migradoV2', new Date().toISOString());
  });
}

/* ---------------- importación inicial ---------------- */
function importarSiVacia() {
  const f = path.join(BASE, 'importar.json');
  if (!fs.existsSync(f)) return;
  const n = st.count.get().n;
  if (n > 0 || db.prepare('SELECT 1 FROM ops LIMIT 1').get() || CFG.sync.repo) return;
  try {
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    tx(() => { for (const [p, d] of Object.entries(data.docs || {})) {
      parsePath(p, true);
      if (p === 'config/correlativo') { if (d.siguienteInterno) setMeta('cor:int', d.siguienteInterno); continue; }
      escribirLocal('set', p, prepararDoc(p, d, 'imp'));
    } });
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
    return send(res, 200, { version: VERSION, hayUsuarios, yo: u ? publicUser(u) : null, ips: ips(), puerto: CFG.puerto, ahora: Date.now(),
      equipo: CFG.equipo, factura: CFG.facturaEnEsteEquipo !== false, uniendo: !!meta('uniendo'), sync: estadoSync(),
      impresoraDirecta: !!CFG.impresora.nombre, windows: process.platform === 'win32' });
  }
  // primer arranque: enlazar con la computadora del restaurante antes de crear usuarios
  if (route === 'enlazar' && req.method === 'POST') {
    if (usuarios().length) throw err(400, 'Esta computadora ya tiene usuarios. Enlázala desde Ajustes.');
    const b = await body(req);
    await configurarSync(b.repo, b.token, 'unirse');
    return send(res, 200, { ok: true, usuarios: usuarios().length });
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
      if (meta('uniendo')) throw err(400, 'Esta computadora está descargando los datos del restaurante. Espera un momento.');
      const nombre = String(b.nombre || '').trim(), usuario = normUsuario(b.usuario), pin = String(b.pin || '').trim();
      validar(nombre, usuario, pin, true);
      const id = crypto.randomUUID().slice(0, 12), salt = crypto.randomBytes(16).toString('hex');
      escribirLocal('set', 'usuarios/' + id, { nombre, usuario, rol: 'admin', activo: true, salt, pinHash: hashPin(pin, salt), creado: new Date().toISOString() });
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
      escribirLocal('set', 'usuarios/' + id, doc);
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
        const top = b.path.split('/')[0];
        let o = op, data = b.data;
        if (o === 'update' && !cur) throw err(400, 'El documento no existe');
        if (top === 'insumos' && o !== 'delete') {
          // la existencia se guarda como movimientos: un ajuste es la diferencia con lo que hay
          data = { ...data }; const quiere = 'stock' in data ? r3(Number(data.stock) || 0) : null; delete data.stock; delete data.movs;
          if (cur) { o = 'update'; if (quiere !== null) { const d = r3(quiere - Number(cur.stock || 0)); data.movs = d ? { [movKey('a')]: d } : {}; } }
          else { o = 'set'; data.movs = quiere ? { [movKey('a')]: quiere } : {}; }
        }
        if (top === 'facturas' && o === 'set' && data && data.metodo === 'Crédito' && !isObj(data.abonos)) { data = { ...data, abonos: {} }; delete data.saldo; delete data.creditoPendiente; }
        if (top === 'mesas' && o === 'update' && 'items' in data) data = { ...data, ultimoCambio: Date.now() };
        escribirLocal(o, b.path, data);
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
        const d = r3(Number(m.delta)); if (!isFinite(d) || !d) continue;
        if (!isAdmin(u) && d > 0) throw err(403, 'No permitido');
        const upd = { movs: { [movKey(b.motivo === 'venta' ? 'v' : b.motivo === 'anulacion' ? 'n' : 'e')]: d } };
        if (isAdmin(u) && m.costo != null && isFinite(Number(m.costo))) upd.costo = Number(m.costo);
        escribirLocal('update', p, upd);
      }
    });
    emitir(['insumos']);
    return send(res, 200, { ok: true });
  }
  if (route === 'siguiente' && req.method === 'POST') {
    const b = await body(req);
    if (CFG.facturaEnEsteEquipo === false) throw err(403, 'Esta computadora no emite facturas. Cobra desde la computadora de la caja.');
    const n = tx(() => {
      const neg = readDoc('config/negocio') || {};
      const conCAI = !!(neg.cai && neg.rangoDesde && neg.rangoHasta);
      if (b.fiscal !== conCAI) throw err(409, 'Los datos de facturación cambiaron. Intenta de nuevo.');
      // nunca repetir un número que ya exista (también los que llegaron de otra computadora)
      const maxUsado = conCAI
        ? db.prepare("SELECT MAX(json_extract(data,'$.nro')) m FROM docs WHERE col='facturas' AND json_extract(data,'$.fiscal')=1 AND json_extract(data,'$.emisor.cai')=?").get(neg.cai)
        : db.prepare("SELECT MAX(json_extract(data,'$.nro')) m FROM docs WHERE col='facturas' AND (json_extract(data,'$.fiscal')=0 OR json_extract(data,'$.fiscal') IS NULL)").get();
      const usado = Number(maxUsado && maxUsado.m) || 0;
      let next;
      if (conCAI) {
        const desde = Math.floor(Number(neg.rangoDesde)), hasta = Math.floor(Number(neg.rangoHasta));
        next = Math.max(desde, Number(meta('cor:cai:' + neg.cai, '0')) || 0, usado + 1);
        if (next > hasta) throw err(400, 'Se agotó el rango autorizado. Solicita un nuevo CAI al SAR y actualízalo en Ajustes.');
        setMeta('cor:cai:' + neg.cai, next + 1);
      } else {
        next = Math.max(1, Number(meta('cor:int', '0')) || 0, usado + 1);
        setMeta('cor:int', next + 1);
      }
      return next;
    });
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
      if (!lineas.length) { if (JSON.stringify(env) !== JSON.stringify(nuevoEnv)) escribirLocal('set', p, { ...m, enviados: nuevoEnv }); return null; }
      escribirLocal('set', p, { ...m, enviados: nuevoEnv });
      const ahora = new Date(); const z = n => String(n).padStart(2, '0'); const dia = `${ahora.getFullYear()}-${z(ahora.getMonth() + 1)}-${z(ahora.getDate())}`;
      let cont = {}; try { cont = JSON.parse(meta('comandas', '{}')); } catch (_) {}
      const numero = cont.dia === dia ? (cont.n || 0) + 1 : 1;
      setMeta('comandas', JSON.stringify({ dia, n: numero }));
      const mu = m.mesero ? readDoc('usuarios/' + m.mesero) : null;
      const comanda = { numero, mesa: m.nombre, cliente: String(m.cliente || '').slice(0, 60), mesero: (mu && mu.nombre) || u.nombre, hora: ahora.toISOString(), lineas };
      return comanda;
    });
    if (r) {
      let impreso = false;
      if (CFG.impresora.nombre) { try { await imprimirDirecto({ tipo: 'comanda', comanda: r }); impreso = true; } catch (e) { log('Impresión directa (comanda):', e.message); } }
      if (!impreso) writeDoc('impresiones/' + crypto.randomUUID().slice(0, 16), { tipo: 'comanda', comanda: r, estado: 'pendiente', creado: new Date().toISOString(), por: u.id });
    }
    emitir(['mesas', 'impresiones']);
    return send(res, 200, { ok: !!r, comanda: r });
  }
  if (route === 'imprimir' && req.method === 'POST') {
    const b = await body(req);
    if (!CFG.impresora.nombre) throw err(400, 'No hay impresora configurada para impresión directa');
    try { await imprimirDirecto(b); } catch (e) { log('Impresión directa:', e.message); throw err(502, e.message); }
    return send(res, 200, { ok: true });
  }
  if (route === 'impresoras' && req.method === 'GET') {
    if (!isAdmin(u)) throw err(403, 'Solo el administrador');
    let lista = [], error = null;
    try { lista = await IMP.listarImpresoras(); } catch (e) { error = e.message; }
    return send(res, 200, { lista, error, actual: CFG.impresora, windows: process.platform === 'win32' });
  }
  if (route === 'impresora' && req.method === 'POST') {
    if (!isAdmin(u)) throw err(403, 'Solo el administrador');
    const b = await body(req);
    const cols = [32, 42, 48, 56, 64].includes(Number(b.columnas)) ? Number(b.columnas) : 48;
    CFG.impresora = { nombre: String(b.nombre || '').slice(0, 200), columnas: cols, acentos: b.acentos !== false, noDetectar: !b.nombre };
    guardarCfg(); log('Impresora directa:', CFG.impresora.nombre || '(ninguna)', cols, 'columnas');
    emitir(['__estado']);
    return send(res, 200, { ok: true, actual: CFG.impresora });
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
  if (route === 'sync') {
    if (req.method === 'POST') {
      if (!isAdmin(u)) throw err(403, 'Solo el administrador');
      const b = await body(req);
      if (b.accion === 'configurar') await configurarSync(b.repo, b.token, b.modo === 'unirse' ? 'unirse' : 'principal');
      else if (b.accion === 'quitar') { CFG.sync = { repo: '', token: '' }; guardarCfg(); SYNC.estado = 'sin configurar'; SYNC.error = null; log('Sincronización desactivada'); }
      else if (b.accion === 'ahora') await sincronizar();
    }
    return send(res, 200, estadoSync());
  }
  if (route === 'equipo' && req.method === 'POST') {
    if (!isAdmin(u)) throw err(403, 'Solo el administrador');
    const b = await body(req);
    if (b.equipo !== undefined) { const n = String(b.equipo).trim().slice(0, 40); if (n) CFG.equipo = n; }
    if (b.factura !== undefined) CFG.facturaEnEsteEquipo = !!b.factura;
    guardarCfg(); emitir(['__estado']);
    return send(res, 200, { ok: true, equipo: CFG.equipo, factura: CFG.facturaEnEsteEquipo });
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

/* ---------------- impresión directa (ESC/POS) ---------------- */
let LOGO_DEF = null;
function logoParaImprimir() {
  const neg = readDoc('config/negocio') || {};
  if (neg.logoFactura === false) return null;
  let data = (readDoc('config/logo') || {}).data;
  if (!data) {
    if (LOGO_DEF === null) { try { LOGO_DEF = (/const LOGO_DEF='(data:image\/png;base64,[^']+)'/.exec(fs.readFileSync(path.join(BASE, 'app.html'), 'utf8')) || [])[1] || ''; } catch (_) { LOGO_DEF = ''; } }
    data = LOGO_DEF;
  }
  const ancho = neg.ahorroPapel === false ? 240 : 160;
  try { return IMP.logoRaster(data, ancho); } catch (e) { log('Logo para imprimir:', e.message); return null; }
}
function bytesTrabajo(job) {
  const o = { cols: Number(CFG.impresora.columnas) || 48, acentos: CFG.impresora.acentos !== false };
  const neg = readDoc('config/negocio') || {};
  if (job.tipo === 'factura') {
    const f = readDoc('facturas/' + String(job.facturaId || ''));
    if (!f) throw new Error('No se encontró la factura');
    return IMP.factura(f, { ...o, logo: logoParaImprimir() });
  }
  if (job.tipo === 'comanda') return IMP.comanda(job.comanda || {}, o);
  if (job.tipo === 'recibo') return IMP.texto(String(job.texto || job.html || ''), { ...o, logo: logoParaImprimir() });
  if (job.tipo === 'prueba') return IMP.prueba({ ...o, logo: logoParaImprimir() }, neg.nombre);
  throw new Error('Tipo de impresión desconocido');
}
// si esta computadora cobra y no tiene impresora directa elegida, busca sola una térmica
async function detectarImpresora() {
  if (process.platform !== 'win32' || CFG.impresora.nombre || CFG.impresora.noDetectar || CFG.facturaEnEsteEquipo === false) return;
  try {
    const lista = await IMP.listarImpresoras();
    const NO = /pdf|xps|onenote|fax|enviar a|send to|anydesk|microsoft print/i;
    const SI = /(pos|xp-?\s?\d|80\s?mm|58\s?mm|thermal|t[eé]rmica|receipt|recibo|ticket|tm-?[tm]\d|tm-?t|rp-?\d|zj-?\d|gprinter|3nstar|bixolon|tsp\d|epson tm|sat\s?\d|xprinter|hprt|rongta|sewoo|citizen ct)/i;
    const cand = lista.filter(p => p && p.nombre && !NO.test(p.nombre + ' ' + (p.driver || '')) && SI.test(p.nombre + ' ' + (p.driver || '')));
    if (!cand.length) { log('Impresión directa: no se encontró una impresora térmica; elígela en Ajustes → Impresora.'); return; }
    const elegida = cand.find(p => p.predeterminada) || cand[0];
    CFG.impresora = { nombre: elegida.nombre, columnas: /58\s?mm|zj-?58|pos-?58/i.test(elegida.nombre + ' ' + (elegida.driver || '')) ? 32 : 48, acentos: true };
    guardarCfg(); log('Impresión directa activada automáticamente en:', elegida.nombre); emitir(['__estado']);
  } catch (e) { log('Impresión directa: no se pudo revisar las impresoras:', e.message); }
}
async function imprimirDirecto(job) {
  if (!CFG.impresora.nombre) throw new Error('No hay impresora configurada');
  await IMP.enviar(CFG.impresora.nombre, bytesTrabajo(job), DATA_DIR);
}

/* ---------------- sincronización con GitHub (repositorio privado) ----------------
 * Archivos:  ops/<equipo>/<AAAA-MM-DD>.jsonl   (una operación por línea)
 * Cada computadora solo escribe sus propios archivos, así nunca hay choques. */
const GH = process.env.RS_GITHUB_API || 'https://api.github.com';
const SYNC = { estado: 'sin configurar', ultimo: Number(meta('ultimaSync', '0')) || null, error: null, pendientes: 0, enCurso: false, recibidos: 0 };
const syncListo = () => !!(CFG.sync && CFG.sync.repo && CFG.sync.token);
function normRepo(r) {
  r = String(r || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r) ? r : '';
}
async function gh(metodo, ruta, cuerpo) {
  let r;
  try {
    r = await fetch(GH + ruta, {
      method: metodo, signal: AbortSignal.timeout(30000),
      headers: { Authorization: 'Bearer ' + CFG.sync.token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'SistemaRestaurante', ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
  } catch (e) { const x = new Error('Sin internet; se sincroniza al volver la conexión'); x.offline = true; throw x; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const x = new Error(j.message || ('GitHub respondió ' + r.status)); x.status = r.status; throw x; }
  return j;
}
function textoError(e, repo) {
  if (e.offline) return e.message;
  if (e.status === 401) return 'La clave (token) de GitHub no es válida o venció';
  if (e.status === 403) return 'La clave (token) no tiene permiso de escritura en ' + repo + ' (Contents: Read and write)';
  if (e.status === 404) return 'No se encontró el repositorio ' + repo + ' o la clave no tiene acceso a él';
  return e.message;
}
let syncTimer = null;
function pedirSync(ms) { if (!syncListo()) return; clearTimeout(syncTimer); syncTimer = setTimeout(() => sincronizar().catch(() => {}), ms); }
const RUTA_OPS = /^ops\/d[0-9a-f]{10}\/\d{4}-\d{2}-\d{2}(-\d+)?\.jsonl$/;
async function leerArbol(repo) {
  const info = await gh('GET', `/repos/${repo}`);
  if (info.private === false) { const x = new Error('El repositorio ' + repo + ' es PÚBLICO. Por seguridad debe ser privado (Settings → Change visibility → Private).'); x.status = 400; throw x; }
  const rama = info.default_branch || 'main';
  let arbol = [];
  try { arbol = (await gh('GET', `/repos/${repo}/git/trees/${encodeURIComponent(rama)}?recursive=1`)).tree || []; }
  catch (e) { if (e.status !== 409 && e.status !== 404) throw e; } // repositorio vacío
  return { info, rama, remotos: new Map(arbol.filter(t => t.type === 'blob' && RUTA_OPS.test(t.path)).map(t => [t.path, t.sha])) };
}
async function sincronizar() {
  if (!syncListo() || SYNC.enCurso) return;
  SYNC.enCurso = true; SYNC.estado = 'sincronizando';
  const repo = CFG.sync.repo;
  try {
    const { rama, remotos } = await leerArbol(repo);
    // 1) bajar lo que cambió en las otras computadoras
    const tocados = new Set(); let nuevas = 0;
    for (const [p, sha] of remotos) {
      if (p.startsWith('ops/' + DEV + '/')) continue;
      if ((st.archGet.get(p) || {}).sha === sha) continue;
      const b = await gh('GET', `/repos/${repo}/git/blobs/${sha}`);
      const texto = Buffer.from(b.content || '', 'base64').toString('utf8');
      tx(() => {
        for (const linea of texto.split('\n')) {
          if (!linea.trim()) continue;
          let o; try { o = JSON.parse(linea); } catch (_) { continue; }
          if (!o || typeof o.id !== 'string' || typeof o.p !== 'string' || !['set', 'update', 'delete'].includes(o.o) || o.d === DEV) continue;
          try { parsePath(o.p, true); } catch (_) { continue; }
          if (esLocal(o.p)) continue;
          const r = st.opAdd.run(o.id, String(o.d), Number(o.s) || 0, Number(o.t) || 0, o.p, o.o, o.o === 'delete' ? null : JSON.stringify(o.v ?? {}), diaLocal(Number(o.t) || 0), 1);
          if (r.changes) { tocados.add(o.p); nuevas++; }
        }
        for (const p2 of tocados) reconstruir(p2);
        st.archSet.run(p, sha);
      });
    }
    if (tocados.size) { SYNC.recibidos += nuevas; emitir([...new Set([...tocados].map(colOf))]); log(`Sincronización: ${nuevas} cambios recibidos de otras computadoras.`); }
    // 2) subir lo de esta computadora
    const dias = db.prepare('SELECT DISTINCT dia FROM ops WHERE dev=? AND subido=0 ORDER BY dia').all(DEV).map(r => r.dia);
    const shaGit = buf => crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + buf.length + '\0'), buf])).digest('hex');
    let cortado = false;
    for (const dia of dias) {
      const filas = db.prepare('SELECT id,seq,ts,path,op,data FROM ops WHERE dev=? AND dia=? ORDER BY seq').all(DEV, dia);
      const maxSeq = filas.length ? filas[filas.length - 1].seq : 0;
      const partes = []; let actual = [], tam = 0;
      for (const f of filas) {
        const linea = JSON.stringify({ id: f.id, d: DEV, s: f.seq, t: f.ts, p: f.path, o: f.op, ...(f.data != null ? { v: JSON.parse(f.data) } : {}) }) + '\n';
        const n = Buffer.byteLength(linea);
        if (actual.length && tam + n > (Number(process.env.RS_PARTE_MAX) || 700000)) { partes.push(actual.join('')); actual = []; tam = 0; }
        actual.push(linea); tam += n;
      }
      if (actual.length) partes.push(actual.join(''));
      for (let k = 0; k < partes.length; k++) {
        const ruta = `ops/${DEV}/${dia}${k ? '-' + (k + 1) : ''}.jsonl`;
        const buf = Buffer.from(partes[k]);
        const shaPrev = remotos.get(ruta);
        if (shaPrev && shaPrev === shaGit(buf)) continue;
        const cuerpo = { message: `${CFG.equipo}: cambios del ${dia}${k ? ' (parte ' + (k + 1) + ')' : ''}`, content: buf.toString('base64'), branch: rama };
        if (shaPrev) cuerpo.sha = shaPrev;
        try {
          const r = await gh('PUT', `/repos/${repo}/contents/${ruta}`, cuerpo);
          if (r && r.content && r.content.sha) remotos.set(ruta, r.content.sha);
        } catch (e) {
          if (e.status === 409 || e.status === 422) { log('Sincronización: el archivo cambió mientras se subía; se reintenta.'); pedirSync(5000); cortado = true; break; }
          throw e;
        }
      }
      if (cortado) break;
      db.prepare('UPDATE ops SET subido=1 WHERE dev=? AND dia=? AND seq<=?').run(DEV, dia, maxSeq);
    }
    SYNC.ultimo = Date.now(); setMeta('ultimaSync', SYNC.ultimo);
    SYNC.estado = 'al día'; SYNC.error = null;
  } catch (e) {
    SYNC.error = textoError(e, repo); SYNC.estado = e.offline ? 'sin internet' : 'error';
    if (!e.offline) log('Sincronización:', SYNC.error);
  } finally {
    SYNC.enCurso = false;
    SYNC.pendientes = db.prepare('SELECT COUNT(*) n FROM ops WHERE dev=? AND subido=0').get(DEV).n;
    emitir(['__estado']);
  }
}
function estadoSync() {
  return { configurado: syncListo(), repo: CFG.sync.repo || '', estado: syncListo() ? SYNC.estado : 'sin configurar', ultimo: SYNC.ultimo, error: SYNC.error,
    pendientes: SYNC.pendientes, equipo: CFG.equipo, factura: CFG.facturaEnEsteEquipo !== false };
}
async function configurarSync(repo, token, modo) {
  repo = normRepo(repo); token = String(token || '').trim();
  if (!repo) throw err(400, 'Escribe el repositorio como usuario/nombre, por ejemplo jonavarela0525-cell/restaurante-datos');
  if (!token) throw err(400, 'Pega la clave (token) de GitHub');
  const prev = { ...CFG.sync };
  CFG.sync = { repo, token };
  let arbol;
  try {
    arbol = await leerArbol(repo);
    if (arbol.info.permissions && arbol.info.permissions.push === false) throw err(400, 'La clave no tiene permiso para escribir en ese repositorio (Contents: Read and write).');
  } catch (e) { CFG.sync = prev; if (e.status === 400) throw err(400, e.message); throw err(400, textoError(e, repo)); }
  const deOtras = [...arbol.remotos.keys()].filter(p => !p.startsWith('ops/' + DEV + '/'));
  if (modo === 'unirse') {
    if (!deOtras.length) { CFG.sync = prev; throw err(400, 'Todavía no hay datos del restaurante en ese repositorio. Primero enlaza la computadora de la CAJA (como principal) y espera a que diga "al día".'); }
    respaldo('antes de enlazar con el restaurante');
    tx(() => {
      db.exec("DELETE FROM docs WHERE col NOT IN ('impresiones'); DELETE FROM ops; DELETE FROM archivos; DELETE FROM sesiones;");
      for (const k of ['cor:int', 'comandas', 'ultimaSync']) st.metaDel.run(k);
      setMeta('uniendo', new Date().toISOString());
    });
    SEQ = 0; CFG.facturaEnEsteEquipo = false;
    guardarCfg(); log('Enlazando con', repo, '(esta computadora recibe los datos del restaurante)');
    emitir(['__reset']);
    await sincronizar();
    if (SYNC.estado !== 'al día') throw err(400, 'Se enlazó, pero no se pudieron descargar los datos: ' + (SYNC.error || '') + '. Se reintentará solo.');
    st.metaDel.run('uniendo');
  } else {
    guardarCfg(); log('Sincronización configurada con', repo, '(principal)');
    sincronizar().catch(() => {});
  }
}

migrarV2();
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
  setTimeout(detectarImpresora, 4000);
  if (CFG.actualizacionesAutomaticas !== false) {
    setTimeout(() => revisarActualizacion(false), 60 * 1000);
    setInterval(() => revisarActualizacion(false), 60 * 60 * 1000);
    setInterval(() => { if (UPD.disponible) aplicarActualizacion(false); }, 2 * 60 * 1000);
  }
  setInterval(() => respaldo('automático'), Math.max(0.25, Number(CFG.horasEntreRespaldos) || 2) * 3600 * 1000);
  if (syncListo()) { SYNC.estado = 'esperando'; setTimeout(() => sincronizar().then(() => { if (meta('uniendo') && SYNC.estado === 'al día') st.metaDel.run('uniendo'); }).catch(() => {}), 3000); }
  setInterval(() => sincronizar().then(() => { if (meta('uniendo') && SYNC.estado === 'al día') st.metaDel.run('uniendo'); }).catch(() => {}), (Number(process.env.RS_SYNC_SEG) || 20) * 1000);
});
function cerrar() { log('Cerrando el sistema...'); try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch (_) {} process.exit(0); }
process.on('SIGINT', cerrar); process.on('SIGTERM', cerrar);
