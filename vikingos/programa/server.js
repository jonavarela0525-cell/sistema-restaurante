'use strict';
/*
 * Sistema Vikingos Licor Store - servidor local
 * Funciona sin internet: todo se guarda en datos/vikingos.db (SQLite).
 * Con internet, se sincroniza con las otras computadoras a través de un
 * repositorio PRIVADO de GitHub (cada computadora sube sus propios cambios).
 * Requiere Node.js 22.13 o superior (https://nodejs.org).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');

const VERSION = '1.3.0';
const REPO_ACTUALIZACIONES = 'jonavarela0525-cell/sistema-restaurante';
const CARPETA_ACTUALIZACIONES = 'vikingos/';
const BASE = __dirname;
const DATA_DIR = path.join(BASE, 'datos');
const BK_DIR = path.join(BASE, 'respaldos');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BK_DIR, { recursive: true });

const CFG_FILE = path.join(BASE, 'config.json');
let CFG = {
  puerto: 8081, carpetaRespaldoExtra: '', respaldosAGuardar: 60, horasEntreRespaldos: 2,
  actualizacionesAutomaticas: true, repoActualizaciones: '',
  equipo: '', prefijoFactura: '000-001-01-', sync: { repo: '', token: '' },
};
try { Object.assign(CFG, JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))); } catch (e) { }
if (!CFG.sync || typeof CFG.sync !== 'object') CFG.sync = { repo: '', token: '' };
if (!CFG.equipo) CFG.equipo = os.hostname() || 'Computadora';
function guardarCfg() { try { fs.writeFileSync(CFG_FILE, JSON.stringify(CFG, null, 2)); } catch (e) { log('No se pudo guardar config.json:', e.message); } }

const LOG_FILE = path.join(DATA_DIR, 'registro.log');
function log(...a) {
  const line = new Date().toISOString() + ' ' + a.join(' ');
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) { }
}
guardarCfg();

/* ---------------- base de datos ---------------- */
(function aplicarRestauracion() {
  const nuevo = path.join(DATA_DIR, 'vikingos_restaurar.db');
  if (!fs.existsSync(nuevo)) return;
  const actual = path.join(DATA_DIR, 'vikingos.db');
  const sello = stamp();
  try {
    for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(actual + ext)) fs.renameSync(actual + ext, path.join(DATA_DIR, `vikingos_antes_de_restaurar_${sello}.db${ext}`));
    fs.renameSync(nuevo, actual);
    log('Respaldo restaurado. La base anterior quedó como vikingos_antes_de_restaurar_' + sello + '.db');
  } catch (e) { log('ERROR al restaurar el respaldo: ' + e.message); }
})();
const db = new DatabaseSync(path.join(DATA_DIR, 'vikingos.db'));
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS docs(path TEXT PRIMARY KEY, col TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_docs_col ON docs(col);
CREATE TABLE IF NOT EXISTS ops(id TEXT PRIMARY KEY, dev TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, path TEXT NOT NULL, op TEXT NOT NULL, data TEXT, dia TEXT NOT NULL, subido INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_ops_path ON ops(path, ts, dev, seq);
CREATE INDEX IF NOT EXISTS ix_ops_subir ON ops(dev, subido, dia);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS sesiones(token TEXT PRIMARY KEY, uid TEXT NOT NULL, creada INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS archivos(path TEXT PRIMARY KEY, sha TEXT NOT NULL);
`);
const st = {
  get: db.prepare('SELECT data FROM docs WHERE path=?'),
  put: db.prepare('INSERT INTO docs(path,col,data,updated) VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data, updated=excluded.updated'),
  del: db.prepare('DELETE FROM docs WHERE path=?'),
  col: db.prepare('SELECT path,data FROM docs WHERE col=?'),
  metaGet: db.prepare('SELECT v FROM meta WHERE k=?'),
  metaSet: db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v'),
  opAdd: db.prepare('INSERT OR IGNORE INTO ops(id,dev,seq,ts,path,op,data,dia,subido) VALUES(?,?,?,?,?,?,?,?,?)'),
  opsPath: db.prepare('SELECT op,data FROM ops WHERE path=? ORDER BY ts,dev,seq'),
  opsDespues: db.prepare('SELECT 1 FROM ops WHERE path=? AND (ts>? OR (ts=? AND (dev>? OR (dev=? AND seq>?)))) LIMIT 1'),
  ses: db.prepare('SELECT uid FROM sesiones WHERE token=?'),
  sesAdd: db.prepare('INSERT INTO sesiones(token,uid,creada) VALUES(?,?,?)'),
  sesDel: db.prepare('DELETE FROM sesiones WHERE token=?'),
  sesDelUid: db.prepare('DELETE FROM sesiones WHERE uid=?'),
  archGet: db.prepare('SELECT sha FROM archivos WHERE path=?'),
  archSet: db.prepare('INSERT INTO archivos(path,sha) VALUES(?,?) ON CONFLICT(path) DO UPDATE SET sha=excluded.sha'),
};
const meta = (k, d) => { const r = st.metaGet.get(k); return r ? r.v : d; };
const setMeta = (k, v) => st.metaSet.run(k, String(v));
// identificador único de esta instalación (nunca se repite entre computadoras)
let DEV = meta('dispositivo');
if (!DEV) { DEV = 'd' + crypto.randomBytes(5).toString('hex'); setMeta('dispositivo', DEV); }

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch (_) { } throw e; }
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
function err(code, msg) { const e = new Error(msg); e.status = code; return e; }
function isObj(o) { return o && typeof o === 'object' && !Array.isArray(o); }
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  return out;
}
function diaLocal(ts) { const d = new Date(ts); const z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; }
function stamp() { const d = new Date(); const z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`; }

/* ------------- registro de cambios (para sincronizar) -------------
 * Cada escritura es una operación (set / update / delete) con fecha, equipo y número.
 * Todas las computadoras aplican las mismas operaciones en el mismo orden, así
 * llegan al mismo resultado aunque hayan vendido sin internet al mismo tiempo.
 * Las existencias y los abonos se guardan como movimientos con nombre propio,
 * por eso nunca se pisan entre computadoras. */
function aplicar(cur, op, data) {
  if (op === 'set') return data;
  if (op === 'update') return cur ? deepMerge(cur, data) : null; // actualizar algo que no existe: se ignora
  return null; // delete
}
function guardarDoc(p, d) { if (d) st.put.run(p, colOf(p), JSON.stringify(d), Date.now()); else st.del.run(p); }
function reconstruir(p) {
  let d = null;
  for (const o of st.opsPath.all(p)) d = aplicar(d, o.op, o.data ? JSON.parse(o.data) : null);
  guardarDoc(p, d);
}
function escribirLocal(op, p, data) {
  // debe llamarse dentro de tx()
  const seq = Number(meta('seq', '0')) + 1; setMeta('seq', seq);
  let ts = Date.now();
  const ult = Number(meta('ultimoTs', '0')); if (ts <= ult) ts = ult + 1; setMeta('ultimoTs', ts);
  const json = op === 'delete' ? null : JSON.stringify(data);
  st.opAdd.run(DEV + ':' + seq, DEV, seq, ts, p, op, json, diaLocal(ts), 0);
  if (st.opsDespues.get(p, ts, ts, DEV, DEV, seq)) reconstruir(p);
  else guardarDoc(p, aplicar(readDoc(p), op, data));
  pedirSync(4000);
}

/* ---------------- usuarios ---------------- */
function hashPin(pin, salt) { return crypto.scryptSync(String(pin), salt, 32).toString('hex'); }
function pinValido(u, pin) {
  pin = String(pin || '').trim();
  if (u.pinHash) return hashPin(pin, u.salt) === u.pinHash;
  if (u.pin) { // usuarios traídos de la versión web
    let h = u.salt + ':' + pin;
    for (let i = 0; i < 300; i++) h = crypto.createHash('sha256').update(h + u.salt).digest('hex');
    return h === u.pin;
  }
  return false;
}
function usuarios() { return st.col.all('usuarios').map(r => ({ id: r.path.split('/')[1], ...JSON.parse(r.data) })); }
function publicUser(u) { return { id: u.id, nombre: u.nombre, rol: u.rol, activo: u.activo !== false }; }
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
function validarUsuario(nombre, pin, obligatorio) {
  if (!nombre) throw err(400, 'Escribe el nombre de la persona');
  if (nombre.length > 40) throw err(400, 'El nombre es muy largo');
  if ((obligatorio || pin) && !/^\d{4,6}$/.test(String(pin || ''))) throw err(400, 'El PIN debe tener de 4 a 6 números');
}

/* ---------------- reglas de acceso ---------------- */
const soloClaves = (obj, ok) => Object.keys(obj || {}).every(k => ok.includes(k));
function checkRead(u, p) {
  const top = p.split('/')[0];
  if (top === 'usuarios' || top === 'sesiones') throw err(403, 'No permitido');
}
function checkWrite(u, op, p, data, existe) {
  const top = p.split('/')[0];
  if (top === 'usuarios' || top === 'sesiones' || top === 'contadores') throw err(403, 'No permitido');
  if (isAdmin(u)) return;
  const NO = () => { throw err(403, 'Solo el administrador puede hacer este cambio'); };
  switch (top) {
    case 'ventas':
      if (op === 'set' && !existe) return;
      if (op === 'update' && existe && soloClaves(data, ['abonos']) && isObj(data.abonos)) return;
      NO(); break;
    case 'productos':
      // cajeros: descontar por venta (v...) o registrar entradas de mercadería (e..., positivas)
      if (op === 'update' && existe && soloClaves(data, ['movs']) && isObj(data.movs) &&
        Object.entries(data.movs).every(([k, v]) => (k[0] === 'v' && Number(v) < 0) || (k[0] === 'e' && Number(v) > 0))) return;
      NO(); break;
    default: NO();
  }
}

/* ---------------- tiempo real (SSE) ---------------- */
const clientes = new Set();
function emitir(cols) {
  const msg = 'data: ' + JSON.stringify({ cols: [...new Set(cols)] }) + '\n\n';
  for (const c of clientes) { try { c.write(msg); } catch (_) { } }
}
setInterval(() => { for (const c of clientes) { try { c.write(': ping\n\n'); } catch (_) { } } }, 25000);

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

/* ---------------- correlativo de facturas (por equipo) ---------------- */
function siguienteFactura() {
  return tx(() => {
    const pref = String(CFG.prefijoFactura || '000-001-01-');
    let n = Number(meta('correlativo:' + pref, '0'));
    // nunca repetir un número que ya exista en las ventas (también las que llegaron de otra computadora)
    const r = db.prepare("SELECT MAX(json_extract(data,'$.num')) m FROM docs WHERE col='ventas' AND json_extract(data,'$.factura') LIKE ?").get(pref.replace(/[%_]/g, '') + '%');
    n = Math.max(n, Number(r && r.m) || 0) + 1;
    setMeta('correlativo:' + pref, n);
    return { num: n, factura: pref + String(n).padStart(8, '0') };
  });
}

/* ---------------- respaldos ---------------- */
function respaldo(motivo) {
  try {
    const nombre = `vikingos_${stamp()}.db`;
    const destino = path.join(BK_DIR, nombre);
    db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
    if (CFG.carpetaRespaldoExtra) {
      try { fs.mkdirSync(CFG.carpetaRespaldoExtra, { recursive: true }); fs.copyFileSync(destino, path.join(CFG.carpetaRespaldoExtra, nombre)); }
      catch (e) { log('No se pudo copiar el respaldo a', CFG.carpetaRespaldoExtra, e.message); }
    }
    const files = fs.readdirSync(BK_DIR).filter(f => /^vikingos_.*\.db$/.test(f)).sort();
    const keep = Math.max(5, CFG.respaldosAGuardar | 0);
    for (const f of files.slice(0, Math.max(0, files.length - keep))) { try { fs.unlinkSync(path.join(BK_DIR, f)); } catch (_) { } }
    log('Respaldo creado (' + motivo + '):', nombre);
    return nombre;
  } catch (e) { log('ERROR al respaldar:', e.message); return null; }
}

/* ---------------- importación inicial (datos de la versión web) ----------------
 * Las operaciones importadas tienen un nombre fijo, así que si se importan en dos
 * computadoras distintas no se duplican al sincronizar. */
const IMPORT_FILE = path.join(BASE, 'importar.json');
const importable = () => fs.existsSync(IMPORT_FILE) && !meta('importado') && usuarios().length === 0;
function importar() {
  const data = JSON.parse(fs.readFileSync(IMPORT_FILE, 'utf8'));
  const ts = Math.min(Number(data.ts) || Date.now(), Date.now() - 1000);
  let n = 0;
  tx(() => {
    for (const [p, d] of Object.entries(data.docs || {})) {
      parsePath(p, true);
      const seq = Number(meta('seq', '0')) + 1; setMeta('seq', seq);
      st.opAdd.run(DEV + ':' + seq, DEV, seq, ts, p, 'set', JSON.stringify(d), diaLocal(ts), 0);
      reconstruir(p); n++;
    }
    setMeta('importado', new Date().toISOString());
  });
  try { fs.renameSync(IMPORT_FILE, path.join(BASE, 'importar_hecho_' + stamp() + '.json')); } catch (_) { }
  log('Datos importados de la versión web:', n, 'documentos');
  pedirSync(2000);
  return n;
}

/* ---------------- sincronización con GitHub (repositorio privado) ----------------
 * Archivos:  ops/<equipo>/<AAAA-MM-DD>.jsonl   (una operación por línea)
 * Cada computadora solo escribe sus propios archivos, así nunca hay choques. */
const GH = process.env.VK_GITHUB_API || 'https://api.github.com';
const SYNC = { estado: 'sin configurar', ultimo: Number(meta('ultimaSync', '0')) || null, error: null, pendientes: 0, enCurso: false, primera: meta('primeraSync') ? true : false };
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
      headers: { Authorization: 'Bearer ' + CFG.sync.token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'SistemaVikingos', ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
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
function pedirSync(ms) { if (!syncListo()) return; clearTimeout(syncTimer); syncTimer = setTimeout(() => sincronizar().catch(() => { }), ms); }
async function sincronizar() {
  if (!syncListo() || SYNC.enCurso) return;
  SYNC.enCurso = true; SYNC.estado = 'sincronizando';
  const repo = CFG.sync.repo;
  try {
    const info = await gh('GET', `/repos/${repo}`);
    if (info.private === false) throw new Error('El repositorio ' + repo + ' es PÚBLICO. Por seguridad debe ser privado (Settings → Change visibility → Private).');
    const rama = info.default_branch || 'main';
    // 1) traer la lista de archivos
    let arbol = [];
    try { arbol = (await gh('GET', `/repos/${repo}/git/trees/${encodeURIComponent(rama)}?recursive=1`)).tree || []; }
    catch (e) { if (e.status !== 409 && e.status !== 404) throw e; } // repositorio vacío
    const remotos = new Map(arbol.filter(t => t.type === 'blob' && /^ops\/[A-Za-z0-9]+\/\d{4}-\d{2}-\d{2}(-\d+)?\.jsonl$/.test(t.path)).map(t => [t.path, t.sha]));
    // 2) bajar lo que cambió en las otras computadoras
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
          if (!o || typeof o.id !== 'string' || typeof o.p !== 'string' || !['set', 'update', 'delete'].includes(o.o)) continue;
          try { parsePath(o.p, true); } catch (_) { continue; }
          const r = st.opAdd.run(o.id, String(o.d), Number(o.s) || 0, Number(o.t) || 0, o.p, o.o, o.o === 'delete' ? null : JSON.stringify(o.v ?? {}), diaLocal(Number(o.t) || 0), 1);
          if (r.changes) { tocados.add(o.p); nuevas++; }
        }
        for (const p2 of tocados) reconstruir(p2);
        st.archSet.run(p, sha);
      });
    }
    if (tocados.size) { emitir([...new Set([...tocados].map(colOf))]); log(`Sincronización: ${nuevas} cambios recibidos de otras computadoras.`); }
    // 3) subir lo de esta computadora
    const dias = db.prepare('SELECT DISTINCT dia FROM ops WHERE dev=? AND subido=0 ORDER BY dia').all(DEV).map(r => r.dia);
    const shaGit = buf => crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + buf.length + '\0'), buf])).digest('hex');
    let cortado = false;
    for (const dia of dias) {
      const filas = db.prepare('SELECT id,seq,ts,path,op,data FROM ops WHERE dev=? AND dia=? ORDER BY seq').all(DEV, dia);
      const maxSeq = filas.length ? filas[filas.length - 1].seq : 0;
      // archivos de hasta ~700 KB (las fotos pesan): dia.jsonl, dia-2.jsonl, dia-3.jsonl...
      const partes = []; let actual = [], tam = 0;
      for (const f of filas) {
        const linea = JSON.stringify({ id: f.id, d: DEV, s: f.seq, t: f.ts, p: f.path, o: f.op, ...(f.data != null ? { v: JSON.parse(f.data) } : {}) }) + '\n';
        const n = Buffer.byteLength(linea);
        if (actual.length && tam + n > (Number(process.env.VK_PARTE_MAX) || 700000)) { partes.push(actual.join('')); actual = []; tam = 0; }
        actual.push(linea); tam += n;
      }
      if (actual.length) partes.push(actual.join(''));
      for (let k = 0; k < partes.length; k++) {
        const ruta = `ops/${DEV}/${dia}${k ? '-' + (k + 1) : ''}.jsonl`;
        const buf = Buffer.from(partes[k]);
        const shaPrev = remotos.get(ruta);
        if (shaPrev && shaPrev === shaGit(buf)) continue; // ya está igual en GitHub
        const cuerpo = { message: `${CFG.equipo || DEV}: cambios del ${dia}${k ? ' (parte ' + (k + 1) + ')' : ''}`, content: buf.toString('base64'), branch: rama };
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
    SYNC.pendientes = db.prepare('SELECT COUNT(*) n FROM ops WHERE dev=? AND subido=0').get(DEV).n;
    SYNC.ultimo = Date.now(); setMeta('ultimaSync', SYNC.ultimo);
    if (!SYNC.primera) { SYNC.primera = true; setMeta('primeraSync', new Date().toISOString()); emitir(['__sync']); }
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
  return { configurado: syncListo(), repo: CFG.sync.repo || '', estado: syncListo() ? SYNC.estado : 'sin configurar', ultimo: SYNC.ultimo, error: SYNC.error, pendientes: SYNC.pendientes, primera: SYNC.primera };
}
async function configurarSync(repo, token) {
  repo = normRepo(repo); token = String(token || '').trim();
  if (!repo) throw err(400, 'Escribe el repositorio como usuario/nombre, por ejemplo jonavarela0525-cell/vikingos-datos');
  if (!token) throw err(400, 'Pega la clave (token) de GitHub');
  const prev = { ...CFG.sync };
  CFG.sync = { repo, token };
  try {
    const info = await gh('GET', `/repos/${repo}`);
    if (info.private === false) throw err(400, 'Ese repositorio es PÚBLICO: cualquiera vería tus ventas. Cámbialo a privado y vuelve a intentar.');
    if (info.permissions && info.permissions.push === false) throw err(400, 'La clave no tiene permiso para escribir en ese repositorio (Contents: Read and write).');
  } catch (e) { CFG.sync = prev; if (e.status === 400) throw e; throw err(400, textoError(e, repo)); }
  guardarCfg(); log('Sincronización configurada con', repo);
  sincronizar().catch(() => { });
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
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function ips() {
  const out = [];
  for (const arr of Object.values(os.networkInterfaces())) for (const i of arr || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}
const esLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

async function api(req, res, url) {
  const route = url.pathname.slice(5);
  if (route === 'estado') {
    const lista = usuarios();
    const u = sessionUser(req);
    return send(res, 200, {
      version: VERSION, hayUsuarios: lista.length > 0, importable: importable(), yo: u ? publicUser(u) : null,
      usuarios: lista.filter(x => x.activo !== false).map(publicUser).sort((a, b) => a.nombre.localeCompare(b.nombre)),
      equipo: CFG.equipo, prefijo: CFG.prefijoFactura, ips: ips(), puerto: CFG.puerto, sync: estadoSync(), ahora: Date.now(),
    });
  }
  if (route === 'importar' && req.method === 'POST') {
    if (!importable()) throw err(400, 'No hay datos para importar en esta computadora');
    return send(res, 200, { ok: true, documentos: importar() });
  }
  // primer arranque: enlazar con otra computadora antes de crear usuarios
  if (route === 'enlazar' && req.method === 'POST') {
    if (usuarios().length) throw err(400, 'Este equipo ya tiene usuarios. Configura la sincronización desde Ajustes.');
    const b = await body(req);
    if (b.prefijo) CFG.prefijoFactura = String(b.prefijo).trim().slice(0, 30);
    if (b.equipo) CFG.equipo = String(b.equipo).trim().slice(0, 40);
    await configurarSync(b.repo, b.token);
    setMeta('importado', 'omitido (equipo enlazado)');
    return send(res, 200, { ok: true });
  }
  if (route === 'configurar' && req.method === 'POST') {
    const b = await body(req);
    return tx(() => {
      if (usuarios().length) throw err(400, 'El sistema ya tiene usuarios. Entra con tu PIN.');
      const nombre = String(b.nombre || '').trim(), pin = String(b.pin || '').trim();
      validarUsuario(nombre, pin, true);
      const id = 'u' + crypto.randomBytes(5).toString('hex'), salt = crypto.randomBytes(16).toString('hex');
      escribirLocal('set', 'usuarios/' + id, { nombre, rol: 'admin', activo: true, salt, pinHash: hashPin(pin, salt), creado: new Date().toISOString() });
      const token = crypto.randomBytes(24).toString('hex'); st.sesAdd.run(token, id, Date.now());
      log('Administrador creado:', nombre);
      send(res, 200, { token, yo: { id, nombre, rol: 'admin', activo: true } });
    });
  }
  if (route === 'entrar' && req.method === 'POST') {
    const b = await body(req);
    const id = String(b.id || '');
    const f = fallos.get(id) || { n: 0, hasta: 0 };
    if (f.hasta > Date.now()) throw err(429, 'Demasiados intentos. Espera un minuto.');
    const u = usuarios().find(x => x.id === id && x.activo !== false);
    if (!u || !pinValido(u, b.pin)) {
      f.n++; if (f.n >= 5) { f.hasta = Date.now() + 60000; f.n = 0; } fallos.set(id, f);
      throw err(401, f.hasta > Date.now() ? 'Demasiados intentos. Espera un minuto.' : 'PIN incorrecto');
    }
    fallos.delete(id);
    const token = crypto.randomBytes(24).toString('hex'); st.sesAdd.run(token, u.id, Date.now());
    log('Inicio de sesión:', u.nombre);
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
  if (route === 'foto' && req.method === 'GET') {
    const id = url.searchParams.get('id') || '';
    if (!SEG.test(id)) throw err(400, 'Foto inválida');
    const d = readDoc('fotos/' + id);
    const m = d && typeof d.img === 'string' && d.img.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
    if (!m) throw err(404, 'Sin foto');
    const buf = Buffer.from(m[2], 'base64');
    res.writeHead(200, { 'Content-Type': m[1], 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=31536000, immutable' });
    return res.end(buf);
  }
  if (route === 'imagenWeb' && req.method === 'GET') {
    if (!isAdmin(u)) throw err(403, 'Solo el administrador');
    let dest; try { dest = new URL(url.searchParams.get('url') || ''); } catch (_) { throw err(400, 'Enlace inválido'); }
    if (!/^https?:$/.test(dest.protocol)) throw err(400, 'Enlace inválido');
    let r;
    try { r = await fetch(dest, { signal: AbortSignal.timeout(20000), redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8' } }); }
    catch (e) { throw err(502, 'No se pudo descargar la imagen (sin internet o la página no respondió)'); }
    if (!r.ok) throw err(502, 'La página de la imagen respondió ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 12 * 1024 * 1024) throw err(413, 'La imagen es demasiado grande');
    const tipo = buf[0] === 0xFF && buf[1] === 0xD8 ? 'image/jpeg' : buf.subarray(1, 4).toString() === 'PNG' ? 'image/png' : buf.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : buf.subarray(0, 3).toString() === 'GIF' ? 'image/gif' : '';
    if (!tipo) throw err(415, 'Ese enlace no es una imagen');
    res.writeHead(200, { 'Content-Type': tipo, 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=86400' });
    return res.end(buf);
  }
  if (route === 'fotosSugeridas' && req.method === 'GET') {
    if (!isAdmin(u)) throw err(403, 'Solo el administrador');
    let d = { productos: [] };
    try { d = JSON.parse(fs.readFileSync(path.join(BASE, 'fotos_sugeridas.json'), 'utf8')); } catch (_) { }
    return send(res, 200, d);
  }
  if (route === 'usuarios' && req.method === 'GET') return send(res, 200, { usuarios: usuarios().map(publicUser) });
  if (route === 'usuarios' && req.method === 'POST') {
    if (!isAdmin(u)) throw err(403, 'Solo el administrador');
    const b = await body(req);
    tx(() => {
      const lista = usuarios();
      const id = b.id ? String(b.id) : 'u' + crypto.randomBytes(5).toString('hex');
      parsePath('usuarios/' + id, true);
      const prev = lista.find(x => x.id === id);
      const nombre = String(b.nombre ?? prev?.nombre ?? '').trim();
      const rol = b.rol === 'admin' ? 'admin' : 'cajero';
      const activo = b.activo === undefined ? (prev ? prev.activo !== false : true) : b.activo !== false;
      validarUsuario(nombre, b.pin, !prev);
      if (lista.some(x => x.id !== id && x.nombre.toLowerCase() === nombre.toLowerCase())) throw err(400, 'Ya existe un usuario con ese nombre');
      if (prev && prev.rol === 'admin' && (rol !== 'admin' || !activo) && lista.filter(x => x.rol === 'admin' && x.activo !== false).length <= 1) throw err(400, 'Debe quedar al menos un administrador activo');
      if (prev && id === u.id && !activo) throw err(400, 'No puedes desactivar tu propio usuario');
      const doc = { ...(prev || {}), nombre, rol, activo }; delete doc.id;
      if (b.pin) { doc.salt = crypto.randomBytes(16).toString('hex'); doc.pinHash = hashPin(String(b.pin).trim(), doc.salt); delete doc.pin; }
      if (!prev) doc.creado = new Date().toISOString();
      escribirLocal('set', 'usuarios/' + id, doc);
      if (!activo || (b.pin && id !== u.id)) st.sesDelUid.run(id);
      log('Usuario guardado por', u.nombre + ':', nombre, rol, activo ? 'activo' : 'inactivo');
    });
    emitir(['usuarios']);
    return send(res, 200, { ok: true });
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
      tx(() => {
        const cur = readDoc(b.path);
        checkWrite(u, op, b.path, b.data, !!cur);
        if (op === 'update' && !cur) throw err(400, 'El documento no existe');
        escribirLocal(op, b.path, b.data);
      });
      ultimaEscritura = Date.now();
      emitir([colOf(b.path)]);
      return send(res, 200, { ok: true });
    }
    throw err(400, 'Operación desconocida');
  }
  if (route === 'siguiente' && req.method === 'POST') return send(res, 200, siguienteFactura());
  if (route === 'equipo' && req.method === 'POST') {
    if (!isAdmin(u)) throw err(403, 'Solo el administrador');
    const b = await body(req);
    if (b.equipo !== undefined) CFG.equipo = String(b.equipo).trim().slice(0, 40) || CFG.equipo;
    if (b.prefijo !== undefined) {
      const p = String(b.prefijo).trim();
      if (!/^[0-9A-Za-z-]{1,30}$/.test(p)) throw err(400, 'El prefijo solo puede tener números, letras y guiones');
      CFG.prefijoFactura = p;
    }
    if (b.carpetaRespaldoExtra !== undefined) CFG.carpetaRespaldoExtra = String(b.carpetaRespaldoExtra).trim();
    guardarCfg(); emitir(['__estado']);
    return send(res, 200, { ok: true });
  }
  if (route === 'sync') {
    if (req.method === 'POST') {
      if (!isAdmin(u)) throw err(403, 'Solo el administrador');
      const b = await body(req);
      if (b.accion === 'configurar') await configurarSync(b.repo, b.token);
      else if (b.accion === 'quitar') { CFG.sync = { repo: '', token: '' }; guardarCfg(); SYNC.estado = 'sin configurar'; SYNC.error = null; }
      else if (b.accion === 'ahora') await sincronizar();
    }
    return send(res, 200, estadoSync());
  }
  if (route === 'actualizacion') {
    if (!isAdmin(u)) throw err(403, 'Solo el administrador');
    if (req.method === 'POST') {
      const b = await body(req);
      if (b.accion === 'revisar') await revisarActualizacion(true);
      else if (b.accion === 'instalar') aplicarActualizacion(true);
    }
    return send(res, 200, { version: VERSION, automatico: CFG.actualizacionesAutomaticas !== false, lanzador: !!process.env.VK_LANZADOR, ...UPD });
  }
  if (route === 'respaldo' && req.method === 'POST') {
    if (!isAdmin(u)) throw err(403, 'Solo el administrador');
    const nombre = respaldo('manual'); if (!nombre) throw err(500, 'No se pudo crear el respaldo');
    return send(res, 200, { nombre, carpeta: BK_DIR, extra: CFG.carpetaRespaldoExtra || '' });
  }
  if (route === 'respaldos' && req.method === 'GET') {
    if (!isAdmin(u)) throw err(403, 'Solo el administrador');
    const files = fs.readdirSync(BK_DIR).filter(f => /^vikingos_.*\.db$/.test(f)).sort().reverse();
    return send(res, 200, { carpeta: BK_DIR, extra: CFG.carpetaRespaldoExtra || '', ultimo: files[0] || null, total: files.length });
  }
  if (route === 'descargarRespaldo' && req.method === 'GET') {
    if (!isAdmin(u)) throw err(403, 'Solo el administrador');
    const nombre = respaldo('descarga'); if (!nombre) throw err(500, 'No se pudo crear el respaldo');
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${nombre}"` });
    return fs.createReadStream(path.join(BK_DIR, nombre)).pipe(res);
  }
  if (route === 'restaurar' && req.method === 'POST') {
    if (!isAdmin(u)) throw err(403, 'Solo el administrador puede restaurar un respaldo');
    const buf = await bodyCrudo(req, 500 * 1024 * 1024);
    if (buf.length < 100 || buf.subarray(0, 16).toString('latin1') !== 'SQLite format 3\u0000') throw err(400, 'Ese archivo no es un respaldo del sistema (debe ser vikingos_....db)');
    const tmp = path.join(DATA_DIR, 'vikingos_restaurar.tmp');
    fs.writeFileSync(tmp, buf);
    try {
      const t = new DatabaseSync(tmp, { readOnly: true });
      const ok = t.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ops'").get();
      t.close(); if (!ok) throw err(400, 'Ese archivo no es un respaldo de Vikingos');
    } catch (e) { try { fs.unlinkSync(tmp); } catch (_) { } if (e.status) throw e; throw err(400, 'El respaldo está dañado'); }
    respaldo('antes de restaurar un respaldo');
    fs.renameSync(tmp, path.join(DATA_DIR, 'vikingos_restaurar.db'));
    send(res, 200, { ok: true, reinicioAutomatico: !!process.env.VK_LANZADOR });
    setTimeout(() => { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch (_) { } process.exit(75); }, 700);
    return;
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
    if (url.pathname === '/favicon.ico') {
      const ico = path.join(BASE, 'vikingos.ico');
      if (fs.existsSync(ico)) { res.writeHead(200, { 'Content-Type': 'image/x-icon' }); return fs.createReadStream(ico).pipe(res); }
      res.writeHead(204); return res.end();
    }
    res.writeHead(404); res.end('No encontrado');
  } catch (e) {
    const code = e.status || 500;
    if (code === 500) log('ERROR', req.method, url.pathname, e.stack || e.message);
    if (!res.headersSent) send(res, code, { error: e.message || 'Error' });
  }
});

/* ---------------- actualizaciones automáticas (igual que el restaurante) ---------------- */
const { spawnSync } = require('child_process');
const PEND = path.join(BASE, 'actualizacion_pendiente');
const ANT = path.join(BASE, 'version_anterior');
const UPD = { estado: 'sin revisar', ultimaRevision: null, disponible: null, error: null };
let ultimaEscritura = 0;
const repoAct = () => String(CFG.repoActualizaciones || REPO_ACTUALIZACIONES || '');
const PROTEGIDOS = new Set(['config.json', 'importar.json', 'fotos_sugeridas.json']);
const NOMBRE_OK = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,80}\.(js|html|vbs|ps1|bat|txt|md|ico)$/;
function cmpVer(a, b) { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; }
const hayActividad = () => Date.now() - ultimaEscritura < 3 * 60000;
let revisando = false;
async function revisarActualizacion(manual) {
  const repo = repoAct();
  if (!repo) { UPD.estado = 'no configurado'; return; }
  if (revisando) return; revisando = true;
  try {
    const base = process.env.VK_UPD_BASE || `https://raw.githubusercontent.com/${repo}/main/${CARPETA_ACTUALIZACIONES}`;
    const r = await fetch(base + 'version.json?t=' + Date.now(), { signal: AbortSignal.timeout(20000), cache: 'no-store' });
    if (!r.ok) throw new Error('No se pudo leer la versión publicada (' + r.status + ')');
    const man = await r.json();
    UPD.ultimaRevision = new Date().toISOString(); UPD.error = null;
    if (!man.version || cmpVer(man.version, VERSION) <= 0) { UPD.estado = 'al día'; UPD.disponible = null; return; }
    const fallidas = fs.readdirSync(DATA_DIR).filter(f => /^actualizacion_fallida_\d+\.json$/.test(f)).map(f => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')).a; } catch (_) { return null; } });
    if (fallidas.includes(man.version)) { UPD.estado = `la versión ${man.version} falló al iniciar y se omitió`; UPD.disponible = null; return; }
    try { const p = JSON.parse(fs.readFileSync(path.join(PEND, 'version.json'), 'utf8')); if (p.version === man.version) { UPD.disponible = man.version; aplicarActualizacion(false); return; } } catch (_) { }
    UPD.estado = 'descargando ' + man.version;
    const tmp = PEND + '_tmp'; fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
    for (const f of man.archivos || []) {
      if (!NOMBRE_OK.test(f.nombre) || PROTEGIDOS.has(f.nombre)) throw new Error('Archivo no permitido en la actualización: ' + f.nombre);
      const rr = await fetch(base + 'programa/' + encodeURIComponent(f.nombre) + '?t=' + Date.now(), { signal: AbortSignal.timeout(60000), cache: 'no-store' });
      if (!rr.ok) throw new Error('No se pudo descargar ' + f.nombre);
      const buf = Buffer.from(await rr.arrayBuffer());
      if (crypto.createHash('sha256').update(buf).digest('hex') !== f.sha256) throw new Error('El archivo ' + f.nombre + ' llegó dañado');
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
  if (!process.env.VK_LANZADOR) { UPD.estado = 'lista: se instalará al reiniciar la computadora'; return false; }
  if (!forzar && hayActividad()) { UPD.estado = `versión ${man.version} lista: se instalará cuando no haya ventas en curso`; return false; }
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
    setTimeout(() => { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch (_) { } process.exit(75); }, 800);
    return true;
  } catch (e) { UPD.estado = 'error'; UPD.error = 'No se pudo instalar: ' + e.message; log(UPD.error); return false; }
}

server.on('error', e => {
  if (e.code === 'EADDRINUSE') { log('El sistema ya está funcionando en el puerto', CFG.puerto); process.exit(0); }
  log('ERROR del servidor:', e.message); process.exit(1);
});
server.listen(CFG.puerto, '0.0.0.0', () => {
  log(`Sistema Vikingos v${VERSION} funcionando (equipo ${CFG.equipo}, ${DEV}).`);
  log(`En esta computadora: http://localhost:${CFG.puerto}`);
  for (const ip of ips()) log(`Desde celulares (mismo WiFi): http://${ip}:${CFG.puerto}`);
  respaldo('inicio');
  if (syncListo()) { SYNC.estado = 'esperando'; setTimeout(() => sincronizar().catch(() => { }), 3000); }
  setInterval(() => sincronizar().catch(() => { }), (Number(process.env.VK_SYNC_SEG) || 60) * 1000);
  if (CFG.actualizacionesAutomaticas !== false) {
    setTimeout(() => revisarActualizacion(false), 60 * 1000);
    setInterval(() => revisarActualizacion(false), 60 * 60 * 1000);
    setInterval(() => { if (UPD.disponible) aplicarActualizacion(false); }, 2 * 60 * 1000);
  }
  setInterval(() => respaldo('automático'), Math.max(0.25, Number(CFG.horasEntreRespaldos) || 2) * 3600 * 1000);
});
function cerrar() { log('Cerrando el sistema...'); try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch (_) { } process.exit(0); }
process.on('SIGINT', cerrar); process.on('SIGTERM', cerrar);
