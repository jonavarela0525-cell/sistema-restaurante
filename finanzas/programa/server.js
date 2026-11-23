'use strict';
/*
 * Mis Finanzas - control personal de ingresos, egresos y cuentas por pagar.
 * Funciona sin internet. Guarda tus datos en datos/finanzas.db (SQLite).
 * Lee (solo lectura, nunca modifica) las bases de los sistemas instalados en esta computadora:
 *   - Casa de la Birria:   %USERPROFILE%\SistemaRestaurante\datos\restaurante.db
 *   - Vikingos Licor Store: %USERPROFILE%\SistemaVikingos\datos\vikingos.db
 * Solo responde en esta computadora (127.0.0.1): no se puede abrir desde otros equipos.
 * Requiere Node.js 22.13 o superior.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');

const VERSION = '1.0.0';
const REPO_ACTUALIZACIONES = 'jonavarela0525-cell/sistema-restaurante';
const CARPETA_ACTUALIZACIONES = 'finanzas/';
const BASE = __dirname;
const DATA_DIR = path.join(BASE, 'datos');
const BK_DIR = path.join(BASE, 'respaldos');
const APP = path.join(BASE, 'app.html');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BK_DIR, { recursive: true });

const HOME = process.env.MF_HOME || os.homedir();
const NEGOCIOS = {
  restaurante: { nombre: 'Casa de la Birria', defecto: path.join(HOME, 'SistemaRestaurante', 'datos', 'restaurante.db') },
  vikingos: { nombre: 'Vikingos Licor Store', defecto: path.join(HOME, 'SistemaVikingos', 'datos', 'vikingos.db') },
};

const CFG_FILE = path.join(BASE, 'config.json');
let CFG = { puerto: 8090, carpetaRespaldoExtra: '', respaldosAGuardar: 60, horasEntreRespaldos: 6, actualizacionesAutomaticas: true, negocios: { restaurante: '', vikingos: '' } };
try { Object.assign(CFG, JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))); } catch (e) {}
if (!CFG.negocios || typeof CFG.negocios !== 'object') CFG.negocios = { restaurante: '', vikingos: '' };
function guardarCfg() { try { fs.writeFileSync(CFG_FILE, JSON.stringify(CFG, null, 2)); } catch (e) { console.log('No se pudo guardar config.json: ' + e.message); } }
guardarCfg();

const LOG_FILE = path.join(DATA_DIR, 'registro.log');
function log(...a) {
  const line = new Date().toISOString() + ' ' + a.join(' ');
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

/* ---------------- base de datos propia ---------------- */
(function aplicarRestauracion() {
  const nuevo = path.join(DATA_DIR, 'finanzas_restaurar.db');
  if (!fs.existsSync(nuevo)) return;
  const actual = path.join(DATA_DIR, 'finanzas.db');
  try {
    for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(actual + ext)) fs.renameSync(actual + ext, path.join(DATA_DIR, `finanzas_antes_de_restaurar_${stamp()}.db${ext}`));
    fs.renameSync(nuevo, actual);
    log('Respaldo restaurado.');
  } catch (e) { log('ERROR al restaurar el respaldo: ' + e.message); }
})();
const db = new DatabaseSync(path.join(DATA_DIR, 'finanzas.db'));
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS sesiones(token TEXT PRIMARY KEY, creada INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS movs(id TEXT PRIMARY KEY, tipo TEXT NOT NULL, fecha TEXT NOT NULL, monto REAL NOT NULL, categoria TEXT NOT NULL DEFAULT '',
  cuenta TEXT NOT NULL DEFAULT '', descripcion TEXT NOT NULL DEFAULT '', origen TEXT NOT NULL DEFAULT 'personal', pago_id TEXT, creado INTEGER NOT NULL, editado INTEGER);
CREATE INDEX IF NOT EXISTS ix_movs_fecha ON movs(fecha);
CREATE TABLE IF NOT EXISTS cxp(id TEXT PRIMARY KEY, acreedor TEXT NOT NULL, concepto TEXT NOT NULL DEFAULT '', monto REAL NOT NULL, vence TEXT NOT NULL,
  origen TEXT NOT NULL DEFAULT 'personal', categoria TEXT NOT NULL DEFAULT '', recurrente TEXT NOT NULL DEFAULT 'no', notas TEXT NOT NULL DEFAULT '',
  estado TEXT NOT NULL DEFAULT 'pendiente', creada INTEGER NOT NULL, siguiente_id TEXT);
CREATE TABLE IF NOT EXISTS pagos(id TEXT PRIMARY KEY, cxp_id TEXT NOT NULL, fecha TEXT NOT NULL, monto REAL NOT NULL, cuenta TEXT NOT NULL DEFAULT '',
  nota TEXT NOT NULL DEFAULT '', mov_id TEXT, creado INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_pagos_cxp ON pagos(cxp_id);
`);
const meta = k => { const r = db.prepare('SELECT v FROM meta WHERE k=?').get(k); return r ? r.v : null; };
const setMeta = (k, v) => db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
function tx(fn) { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; } }
const nid = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const z = n => String(n).padStart(2, '0');
function diaLocal(ts) { const d = new Date(ts); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; }
function stamp() { const d = new Date(); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`; }
function err(code, msg) { const e = new Error(msg); e.status = code; return e; }
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const ORIGENES = new Set(['personal', 'restaurante', 'vikingos']);
const RECURRENCIAS = new Set(['no', 'semanal', 'quincenal', 'mensual', 'anual']);
function texto(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 200); }
function montoOk(v) { const n = r2(v); if (!(n > 0) || n > 1e10) throw err(400, 'Escribe un monto mayor que cero'); return n; }
function fechaOk(v) { const s = String(v || ''); if (!FECHA.test(s) || isNaN(new Date(s + 'T12:00:00'))) throw err(400, 'Fecha inválida'); return s; }

/* ---------------- lectura de los sistemas de los negocios (solo lectura) ---------------- */
function rutaNegocio(k) { return (CFG.negocios && CFG.negocios[k]) || NEGOCIOS[k].defecto; }
function abrirNegocio(k) {
  const p = rutaNegocio(k);
  if (!fs.existsSync(p)) throw err(404, 'No se encontró el sistema en esta computadora');
  try {
    const d = new DatabaseSync(p, { readOnly: true });
    d.exec('PRAGMA busy_timeout=3000');
    d.prepare('SELECT 1 FROM docs LIMIT 1').get();
    return d;
  } catch (e) {
    // si no se puede abrir directo (por ejemplo el sistema está apagado y quedó el diario sin cerrar), se lee una copia
    const tmp = path.join(os.tmpdir(), `misfinanzas_${k}.db`);
    for (const ext of ['', '-wal', '-shm']) { try { fs.rmSync(tmp + ext, { force: true }); } catch (_) {} }
    fs.copyFileSync(p, tmp);
    if (fs.existsSync(p + '-wal')) fs.copyFileSync(p + '-wal', tmp + '-wal');
    const d = new DatabaseSync(tmp);
    d.prepare('SELECT 1 FROM docs LIMIT 1').get();
    return d;
  }
}
const parse = r => { try { return JSON.parse(r.data); } catch (_) { return null; } };
const esCredito = m => String(m || '').toLowerCase().startsWith('créd') || String(m || '').toLowerCase().startsWith('cred');

/*
 * Devuelve, para un rango de días, lo que el negocio COBRÓ (ventas de contado + abonos de créditos),
 * lo que vendió al crédito (todavía no es dinero recibido), sus gastos de caja y los créditos pendientes.
 * Los créditos se cuentan como ingreso cuando el cliente abona, así nada se cuenta dos veces.
 */
function leerNegocio(k, desde, hasta) {
  const out = { clave: k, nombre: NEGOCIOS[k].nombre, ok: false, error: null, ruta: rutaNegocio(k), actualizado: null,
    ingresos: [], gastos: [], creditos: [], creditoDias: [], ventasCredito: 0, nFacturas: 0 };
  let d;
  try { d = abrirNegocio(k); } catch (e) { out.error = e.message; return out; }
  try {
    out.actualizado = (d.prepare('SELECT MAX(updated) m FROM docs').get() || {}).m || null;
    const rango = d.prepare("SELECT path, data FROM docs WHERE col=? AND json_extract(data,'$.dia') BETWEEN ? AND ?");
    if (k === 'restaurante') {
      for (const f of rango.all('facturas', desde, hasta).map(parse)) {
        if (!f || f.anulada) continue;
        out.nFacturas++;
        const total = r2(f.totalPagar != null ? f.totalPagar : f.total);
        if (esCredito(f.metodo)) { out.ventasCredito = r2(out.ventasCredito + total); out.creditoDias.push({ dia: f.dia, monto: total }); }
        else out.ingresos.push({ dia: f.dia, monto: total, tipo: 'venta', metodo: f.metodo || '' });
      }
      const fact = d.prepare('SELECT data FROM docs WHERE path=?'); const anul = {};
      for (const a of rango.all('abonos', desde, hasta).map(parse)) {
        if (!a || a.anulado) continue;
        if (a.facturaId) {
          if (!(a.facturaId in anul)) { const r = fact.get('facturas/' + a.facturaId); const f = r ? parse(r) : null; anul[a.facturaId] = !f || !!f.anulada; }
          if (anul[a.facturaId]) continue;
        }
        out.ingresos.push({ dia: a.dia, monto: r2(a.monto), tipo: 'abono', metodo: a.metodo || '', cliente: a.cliente || '' });
      }
      for (const r of d.prepare("SELECT data FROM docs WHERE col='facturas' AND json_extract(data,'$.creditoPendiente')=1").all()) {
        const f = parse(r); if (!f || f.anulada || !(Number(f.saldo) > 0.004)) continue;
        out.creditos.push({ cliente: f.cliente || 'Sin nombre', numero: f.numero || '', fecha: f.dia || '', vence: f.vence || '', total: r2(f.totalPagar), saldo: r2(f.saldo) });
      }
    } else {
      for (const v of rango.all('ventas', desde, hasta).map(parse)) {
        if (!v || v.anulada) continue;
        out.nFacturas++;
        const total = r2(v.total);
        if (esCredito(v.pago)) { out.ventasCredito = r2(out.ventasCredito + total); out.creditoDias.push({ dia: v.dia, monto: total }); }
        else out.ingresos.push({ dia: v.dia, monto: total, tipo: 'venta', metodo: v.pago || '' });
      }
      for (const r of d.prepare("SELECT data FROM docs WHERE col='ventas' AND json_extract(data,'$.pago')='Crédito'").all()) {
        const v = parse(r); if (!v || v.anulada) continue;
        let abonado = 0;
        for (const a of Object.values(v.abonos && typeof v.abonos === 'object' ? v.abonos : {})) {
          const m = Number(a && typeof a === 'object' ? a.monto : a) || 0; abonado += m;
          const ts = a && a.ts; if (!ts) continue;
          const dd = diaLocal(ts);
          if (dd >= desde && dd <= hasta && m) out.ingresos.push({ dia: dd, monto: r2(m), tipo: 'abono', metodo: a.pago || '', cliente: v.cliente || '' });
        }
        const saldo = Math.max(0, r2(Number(v.total || 0) - abonado));
        if (saldo > 0.004) out.creditos.push({ cliente: v.cliente || 'Sin nombre', numero: v.factura || String(v.num || ''), fecha: v.dia || '', vence: v.vence || '', total: r2(v.total), saldo, tel: v.tel || '' });
      }
    }
    for (const g of rango.all('gastos', desde, hasta).map(parse)) {
      if (!g || g.anulado) continue;
      out.gastos.push({ dia: g.dia, monto: r2(g.monto), categoria: g.cat || 'Gasto', descripcion: g.desc || '', cuenta: g.pago || '' });
    }
    out.creditos.sort((a, b) => (a.vence || '9999').localeCompare(b.vence || '9999'));
    out.ok = true;
  } catch (e) { out.error = 'No se pudieron leer los datos: ' + e.message; log('Lectura', k, e.message); }
  finally { try { d.close(); } catch (_) {} }
  return out;
}

/* ---------------- sesiones / PIN ---------------- */
function hashPin(pin, sal) { return crypto.scryptSync(String(pin), sal, 32).toString('hex'); }
let intentos = 0, bloqueoHasta = 0;
function usuario(req) {
  const t = req.headers['x-token'];
  if (!t) return null;
  const r = db.prepare('SELECT creada FROM sesiones WHERE token=?').get(String(t));
  if (!r) return null;
  if (Date.now() - r.creada > 30 * 86400000) { db.prepare('DELETE FROM sesiones WHERE token=?').run(String(t)); return null; }
  return { token: String(t) };
}
function nuevaSesion() { const t = crypto.randomBytes(24).toString('hex'); db.prepare('INSERT INTO sesiones(token,creada) VALUES(?,?)').run(t, Date.now()); return t; }

/* ---------------- cuentas por pagar ---------------- */
function sumarPeriodo(fecha, rec) {
  const [y, m, d] = fecha.split('-').map(Number);
  if (rec === 'semanal' || rec === 'quincenal') { const x = new Date(y, m - 1, d + (rec === 'semanal' ? 7 : 15)); return diaLocal(x); }
  const meses = rec === 'anual' ? 12 : 1;
  const ult = new Date(y, m - 1 + meses + 1, 0).getDate();
  const x = new Date(y, m - 1 + meses, Math.min(d, ult));
  return diaLocal(x);
}
function cxpConPagos(c) {
  const pagos = db.prepare('SELECT * FROM pagos WHERE cxp_id=? ORDER BY fecha, creado').all(c.id);
  const pagado = r2(pagos.reduce((a, p) => a + p.monto, 0));
  return { ...c, pagos, pagado, saldo: c.estado === 'anulada' ? 0 : Math.max(0, r2(c.monto - pagado)) };
}
function listaCxp() {
  return db.prepare("SELECT * FROM cxp ORDER BY CASE estado WHEN 'pendiente' THEN 0 ELSE 1 END, vence").all().map(cxpConPagos);
}
function pagarCxp(b) {
  return tx(() => {
    const c = db.prepare('SELECT * FROM cxp WHERE id=?').get(String(b.id || ''));
    if (!c) throw err(404, 'No se encontró la cuenta');
    if (c.estado !== 'pendiente') throw err(400, 'Esta cuenta ya no está pendiente');
    const cc = cxpConPagos(c);
    const monto = montoOk(b.monto); const fecha = fechaOk(b.fecha); const cuenta = texto(b.cuenta, 60); const nota = texto(b.nota, 200);
    if (monto > cc.saldo + 0.004) throw err(400, 'El pago es mayor que el saldo pendiente (L ' + cc.saldo.toFixed(2) + ')');
    const pid = nid(), mid = nid(), ahora = Date.now();
    const desc = 'Pago a ' + c.acreedor + (c.concepto ? ' — ' + c.concepto : '') + (nota ? ' (' + nota + ')' : '');
    db.prepare('INSERT INTO movs(id,tipo,fecha,monto,categoria,cuenta,descripcion,origen,pago_id,creado) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(mid, 'egreso', fecha, monto, c.categoria || 'Cuentas por pagar', cuenta, desc, c.origen, pid, ahora);
    db.prepare('INSERT INTO pagos(id,cxp_id,fecha,monto,cuenta,nota,mov_id,creado) VALUES(?,?,?,?,?,?,?,?)').run(pid, c.id, fecha, monto, cuenta, nota, mid, ahora);
    let siguiente = null;
    if (monto >= cc.saldo - 0.004) {
      db.prepare("UPDATE cxp SET estado='pagada' WHERE id=?").run(c.id);
      if (c.recurrente !== 'no' && !c.siguiente_id) {
        const sid = nid(); const vence = sumarPeriodo(c.vence, c.recurrente);
        db.prepare('INSERT INTO cxp(id,acreedor,concepto,monto,vence,origen,categoria,recurrente,notas,estado,creada) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(sid, c.acreedor, c.concepto, c.monto, vence, c.origen, c.categoria, c.recurrente, c.notas, 'pendiente', ahora);
        db.prepare('UPDATE cxp SET siguiente_id=? WHERE id=?').run(sid, c.id);
        siguiente = vence;
      }
    }
    return { ok: true, siguiente };
  });
}
function deshacerPago(pagoId) {
  return tx(() => {
    const p = db.prepare('SELECT * FROM pagos WHERE id=?').get(String(pagoId || ''));
    if (!p) throw err(404, 'No se encontró el pago');
    const c = db.prepare('SELECT * FROM cxp WHERE id=?').get(p.cxp_id);
    db.prepare('DELETE FROM pagos WHERE id=?').run(p.id);
    if (p.mov_id) db.prepare('DELETE FROM movs WHERE id=?').run(p.mov_id);
    if (c && c.estado === 'pagada') {
      db.prepare("UPDATE cxp SET estado='pendiente' WHERE id=?").run(c.id);
      // si ya se había creado la siguiente cuota y no tiene pagos, se quita para no duplicarla
      if (c.siguiente_id) {
        const tiene = db.prepare('SELECT 1 FROM pagos WHERE cxp_id=? LIMIT 1').get(c.siguiente_id);
        if (!tiene) { db.prepare('DELETE FROM cxp WHERE id=?').run(c.siguiente_id); db.prepare('UPDATE cxp SET siguiente_id=NULL WHERE id=?').run(c.id); }
      }
    }
    return { ok: true };
  });
}

/* ---------------- resumen ---------------- */
function mesesAtras(hasta, n) {
  const [y, m] = hasta.split('-').map(Number); const out = [];
  for (let i = n - 1; i >= 0; i--) { const d = new Date(y, m - 1 - i, 1); out.push(`${d.getFullYear()}-${z(d.getMonth() + 1)}`); }
  return out;
}
function datos(desde, hasta) {
  const neg = {};
  for (const k of Object.keys(NEGOCIOS)) neg[k] = leerNegocio(k, desde, hasta);
  const movs = db.prepare('SELECT * FROM movs WHERE fecha BETWEEN ? AND ? ORDER BY fecha DESC, creado DESC').all(desde, hasta);
  return { neg, movs };
}
function resumen(desde, hasta) {
  const meses = mesesAtras(hasta, 12);
  const desdeSerie = meses[0] + '-01';
  const ini = desde < desdeSerie ? desde : desdeSerie;
  const { neg, movs } = datos(ini, hasta);
  const enRango = x => x >= desde && x <= hasta;
  const fuentes = {
    restaurante: { ingresos: 0, egresos: 0 }, vikingos: { ingresos: 0, egresos: 0 }, personal: { ingresos: 0, egresos: 0 },
  };
  const serie = Object.fromEntries(meses.map(m => [m, { ingresos: 0, egresos: 0 }]));
  const catEgr = {}, catIng = {};
  const add = (origen, tipo, dia, monto, cat) => {
    const mes = dia.slice(0, 7);
    if (serie[mes]) serie[mes][tipo] = r2(serie[mes][tipo] + monto);
    if (!enRango(dia)) return;
    fuentes[origen][tipo] = r2(fuentes[origen][tipo] + monto);
    const mapa = tipo === 'egresos' ? catEgr : catIng;
    mapa[cat] = r2((mapa[cat] || 0) + monto);
  };
  const detalle = {};
  for (const [k, n] of Object.entries(neg)) {
    const nom = NEGOCIOS[k].nombre;
    for (const i of n.ingresos) add(k, 'ingresos', i.dia, i.monto, i.tipo === 'abono' ? 'Abonos de créditos — ' + nom : 'Ventas — ' + nom);
    for (const g of n.gastos) add(k, 'egresos', g.dia, g.monto, g.categoria);
    const ing = n.ingresos.filter(i => enRango(i.dia));
    detalle[k] = { nombre: nom, ok: n.ok, error: n.error, actualizado: n.actualizado,
      ventasContado: r2(ing.filter(i => i.tipo === 'venta').reduce((a, i) => a + i.monto, 0)),
      abonos: r2(ing.filter(i => i.tipo === 'abono').reduce((a, i) => a + i.monto, 0)),
      gastos: r2(n.gastos.filter(g => enRango(g.dia)).reduce((a, g) => a + g.monto, 0)),
      porCobrar: r2(n.creditos.reduce((a, c) => a + c.saldo, 0)), nCreditos: n.creditos.length };
  }
  for (const m of movs) add(ORIGENES.has(m.origen) ? m.origen : 'personal', m.tipo === 'ingreso' ? 'ingresos' : 'egresos', m.fecha, m.monto, m.categoria || 'Otros');
  // ventas al crédito solo del rango pedido (no es dinero recibido todavía)
  for (const k of Object.keys(NEGOCIOS)) detalle[k].ventasCredito = r2(neg[k].creditoDias.filter(c => enRango(c.dia)).reduce((a, c) => a + c.monto, 0));

  const cx = listaCxp().filter(c => c.estado === 'pendiente');
  const hoy = diaLocal(Date.now()); const en15 = diaLocal(Date.now() + 15 * 86400000);
  const tot = o => r2(Object.values(fuentes).reduce((a, f) => a + f[o], 0));
  const orden = m => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([nombre, monto]) => ({ nombre, monto }));
  return {
    desde, hasta, ingresos: tot('ingresos'), egresos: tot('egresos'), balance: r2(tot('ingresos') - tot('egresos')),
    fuentes, negocios: detalle,
    serie: meses.map(m => ({ mes: m, ...serie[m] })),
    categoriasEgreso: orden(catEgr), categoriasIngreso: orden(catIng),
    porPagar: { total: r2(cx.reduce((a, c) => a + c.saldo, 0)), vencido: r2(cx.filter(c => c.vence < hoy).reduce((a, c) => a + c.saldo, 0)),
      nVencidas: cx.filter(c => c.vence < hoy).length, n: cx.length,
      proximas: cx.filter(c => c.vence <= en15).slice(0, 12).map(c => ({ id: c.id, acreedor: c.acreedor, concepto: c.concepto, vence: c.vence, saldo: c.saldo, origen: c.origen })) },
    porCobrar: r2(Object.values(detalle).reduce((a, n) => a + (n.porCobrar || 0), 0)),
  };
}

function movimientos(desde, hasta) {
  const { neg, movs } = datos(desde, hasta);
  const lista = movs.map(m => ({ id: m.id, fecha: m.fecha, tipo: m.tipo, monto: m.monto, categoria: m.categoria, cuenta: m.cuenta, descripcion: m.descripcion,
    origen: m.origen, editable: !m.pago_id, dePago: !!m.pago_id, ts: m.creado }));
  for (const [k, n] of Object.entries(neg)) {
    const porDia = {};
    for (const i of n.ingresos) {
      const d = porDia[i.dia] || (porDia[i.dia] = { ventas: 0, nVentas: 0, abonos: 0, nAbonos: 0 });
      if (i.tipo === 'venta') { d.ventas += i.monto; d.nVentas++; } else { d.abonos += i.monto; d.nAbonos++; }
    }
    for (const [dia, d] of Object.entries(porDia)) {
      const partes = [];
      if (d.nVentas) partes.push(d.nVentas + (d.nVentas === 1 ? ' venta' : ' ventas') + ' de contado');
      if (d.nAbonos) partes.push(d.nAbonos + (d.nAbonos === 1 ? ' abono' : ' abonos') + ' de crédito');
      lista.push({ id: k + ':ing:' + dia, fecha: dia, tipo: 'ingreso', monto: r2(d.ventas + d.abonos), categoria: 'Ingresos del negocio', cuenta: '',
        descripcion: 'Cobrado en el día: ' + partes.join(' + '), origen: k, editable: false, ts: 0 });
    }
    n.gastos.forEach((g, i) => lista.push({ id: k + ':g:' + g.dia + ':' + i, fecha: g.dia, tipo: 'egreso', monto: g.monto, categoria: g.categoria, cuenta: g.cuenta,
      descripcion: g.descripcion || 'Gasto de caja', origen: k, editable: false, ts: 0 }));
  }
  lista.sort((a, b) => b.fecha.localeCompare(a.fecha) || (b.ts - a.ts));
  const estado = Object.fromEntries(Object.entries(neg).map(([k, n]) => [k, { ok: n.ok, error: n.error }]));
  return { movimientos: lista, negocios: estado };
}

/* ---------------- respaldos ---------------- */
function respaldo(motivo) {
  try {
    const nombre = `finanzas_${stamp()}.db`;
    const destino = path.join(BK_DIR, nombre);
    db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
    if (CFG.carpetaRespaldoExtra) {
      try { fs.mkdirSync(CFG.carpetaRespaldoExtra, { recursive: true }); fs.copyFileSync(destino, path.join(CFG.carpetaRespaldoExtra, nombre)); }
      catch (e) { log('No se pudo copiar el respaldo a', CFG.carpetaRespaldoExtra, e.message); }
    }
    const files = fs.readdirSync(BK_DIR).filter(f => /^finanzas_.*\.db$/.test(f)).sort();
    const keep = Math.max(5, CFG.respaldosAGuardar | 0);
    for (const f of files.slice(0, Math.max(0, files.length - keep))) { try { fs.unlinkSync(path.join(BK_DIR, f)); } catch (_) {} }
    log('Respaldo creado (' + motivo + '):', nombre);
    return nombre;
  } catch (e) { log('ERROR al respaldar:', e.message); return null; }
}

/* ---------------- API ---------------- */
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function leerCuerpo(req) {
  return new Promise((ok, mal) => {
    let s = ''; req.on('data', c => { s += c; if (s.length > 1e6) { mal(err(413, 'Demasiado grande')); req.destroy(); } });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (_) { mal(err(400, 'Datos inválidos')); } });
  });
}
function rangoDe(url) {
  const hoy = diaLocal(Date.now());
  const desde = FECHA.test(url.searchParams.get('desde') || '') ? url.searchParams.get('desde') : hoy.slice(0, 8) + '01';
  const hasta = FECHA.test(url.searchParams.get('hasta') || '') ? url.searchParams.get('hasta') : hoy;
  if (desde > hasta) throw err(400, 'La fecha inicial es mayor que la final');
  return { desde, hasta };
}
function csv(v) { const s = String(v == null ? '' : v); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
const NOMBRE_ORIGEN = { personal: 'Personal', restaurante: 'Casa de la Birria', vikingos: 'Vikingos Licor Store' };

async function api(req, res, url) {
  const route = url.pathname.slice(5);
  const hayPin = !!meta('pin');
  if (route === 'estado') {
    return send(res, 200, { version: VERSION, configurado: hayPin, sesion: !!usuario(req), nombre: meta('nombre') || '', actualizacion: UPD });
  }
  if (route === 'configurar' && req.method === 'POST') {
    if (hayPin) throw err(400, 'El PIN ya está creado');
    const b = await leerCuerpo(req); const pin = String(b.pin || '');
    if (!/^\d{4,8}$/.test(pin)) throw err(400, 'El PIN debe tener de 4 a 8 números');
    const sal = crypto.randomBytes(16).toString('hex');
    setMeta('pin', sal + ':' + hashPin(pin, sal)); setMeta('nombre', texto(b.nombre, 60));
    return send(res, 200, { token: nuevaSesion() });
  }
  if (route === 'entrar' && req.method === 'POST') {
    if (Date.now() < bloqueoHasta) throw err(429, 'Demasiados intentos. Espera un momento.');
    const b = await leerCuerpo(req); const [sal, h] = String(meta('pin') || ':').split(':');
    const ok = h && crypto.timingSafeEqual(Buffer.from(hashPin(String(b.pin || ''), sal), 'hex'), Buffer.from(h, 'hex'));
    if (!ok) { intentos++; if (intentos >= 5) { bloqueoHasta = Date.now() + 60000; intentos = 0; } throw err(401, 'PIN incorrecto'); }
    intentos = 0;
    return send(res, 200, { token: nuevaSesion() });
  }
  const u = usuario(req);
  if (!u) throw err(401, 'Ingresa tu PIN');
  if (route === 'salir' && req.method === 'POST') { db.prepare('DELETE FROM sesiones WHERE token=?').run(u.token); return send(res, 200, { ok: true }); }

  if (route === 'resumen') { const { desde, hasta } = rangoDe(url); return send(res, 200, resumen(desde, hasta)); }
  if (route === 'movimientos' && req.method === 'GET') { const { desde, hasta } = rangoDe(url); return send(res, 200, movimientos(desde, hasta)); }
  if (route === 'movimiento' && req.method === 'POST') {
    const b = await leerCuerpo(req);
    const tipo = b.tipo === 'ingreso' ? 'ingreso' : b.tipo === 'egreso' ? 'egreso' : null; if (!tipo) throw err(400, 'Tipo inválido');
    const fila = { tipo, fecha: fechaOk(b.fecha), monto: montoOk(b.monto), categoria: texto(b.categoria, 60) || 'Otros', cuenta: texto(b.cuenta, 60),
      descripcion: texto(b.descripcion, 200), origen: ORIGENES.has(b.origen) ? b.origen : 'personal' };
    if (b.id) {
      const cur = db.prepare('SELECT * FROM movs WHERE id=?').get(String(b.id));
      if (!cur) throw err(404, 'No se encontró el movimiento');
      if (cur.pago_id) throw err(400, 'Este movimiento es un pago de una cuenta por pagar: cámbialo desde "Cuentas por pagar"');
      db.prepare('UPDATE movs SET tipo=?,fecha=?,monto=?,categoria=?,cuenta=?,descripcion=?,origen=?,editado=? WHERE id=?')
        .run(fila.tipo, fila.fecha, fila.monto, fila.categoria, fila.cuenta, fila.descripcion, fila.origen, Date.now(), cur.id);
      return send(res, 200, { ok: true, id: cur.id });
    }
    const id = nid();
    db.prepare('INSERT INTO movs(id,tipo,fecha,monto,categoria,cuenta,descripcion,origen,creado) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, fila.tipo, fila.fecha, fila.monto, fila.categoria, fila.cuenta, fila.descripcion, fila.origen, Date.now());
    return send(res, 200, { ok: true, id });
  }
  if (route === 'movimiento/borrar' && req.method === 'POST') {
    const b = await leerCuerpo(req); const cur = db.prepare('SELECT * FROM movs WHERE id=?').get(String(b.id || ''));
    if (!cur) throw err(404, 'No se encontró el movimiento');
    if (cur.pago_id) throw err(400, 'Este movimiento es un pago: deshazlo desde "Cuentas por pagar"');
    db.prepare('DELETE FROM movs WHERE id=?').run(cur.id);
    return send(res, 200, { ok: true });
  }
  if (route === 'categorias') {
    const c = db.prepare("SELECT tipo, categoria, COUNT(*) n FROM movs GROUP BY tipo, categoria ORDER BY n DESC").all();
    const cu = db.prepare("SELECT cuenta, COUNT(*) n FROM movs WHERE cuenta<>'' GROUP BY cuenta ORDER BY n DESC").all().map(x => x.cuenta);
    const ac = db.prepare("SELECT acreedor, COUNT(*) n FROM cxp GROUP BY acreedor ORDER BY n DESC").all().map(x => x.acreedor);
    return send(res, 200, { ingreso: c.filter(x => x.tipo === 'ingreso').map(x => x.categoria), egreso: c.filter(x => x.tipo === 'egreso').map(x => x.categoria), cuentas: cu, acreedores: ac });
  }
  if (route === 'cxp' && req.method === 'GET') return send(res, 200, { cuentas: listaCxp() });
  if (route === 'cxp' && req.method === 'POST') {
    const b = await leerCuerpo(req);
    const f = { acreedor: texto(b.acreedor, 80), concepto: texto(b.concepto, 120), monto: montoOk(b.monto), vence: fechaOk(b.vence),
      origen: ORIGENES.has(b.origen) ? b.origen : 'personal', categoria: texto(b.categoria, 60) || 'Cuentas por pagar',
      recurrente: RECURRENCIAS.has(b.recurrente) ? b.recurrente : 'no', notas: texto(b.notas, 300) };
    if (!f.acreedor) throw err(400, 'Escribe a quién le debes');
    if (b.id) {
      const cur = db.prepare('SELECT * FROM cxp WHERE id=?').get(String(b.id)); if (!cur) throw err(404, 'No se encontró la cuenta');
      const pagado = cxpConPagos(cur).pagado;
      if (f.monto < pagado - 0.004) throw err(400, 'El monto no puede ser menor que lo ya pagado (L ' + pagado.toFixed(2) + ')');
      tx(() => {
        db.prepare('UPDATE cxp SET acreedor=?,concepto=?,monto=?,vence=?,origen=?,categoria=?,recurrente=?,notas=? WHERE id=?')
          .run(f.acreedor, f.concepto, f.monto, f.vence, f.origen, f.categoria, f.recurrente, f.notas, cur.id);
        if (cur.estado === 'pendiente' && pagado > 0 && f.monto <= pagado + 0.004) db.prepare("UPDATE cxp SET estado='pagada' WHERE id=?").run(cur.id);
        if (cur.estado === 'pagada' && f.monto > pagado + 0.004) db.prepare("UPDATE cxp SET estado='pendiente' WHERE id=?").run(cur.id);
      });
      return send(res, 200, { ok: true });
    }
    const id = nid();
    db.prepare('INSERT INTO cxp(id,acreedor,concepto,monto,vence,origen,categoria,recurrente,notas,estado,creada) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, f.acreedor, f.concepto, f.monto, f.vence, f.origen, f.categoria, f.recurrente, f.notas, 'pendiente', Date.now());
    return send(res, 200, { ok: true, id });
  }
  if (route === 'cxp/pagar' && req.method === 'POST') return send(res, 200, pagarCxp(await leerCuerpo(req)));
  if (route === 'cxp/deshacerPago' && req.method === 'POST') return send(res, 200, deshacerPago((await leerCuerpo(req)).id));
  if (route === 'cxp/anular' && req.method === 'POST') {
    const b = await leerCuerpo(req); const cur = db.prepare('SELECT * FROM cxp WHERE id=?').get(String(b.id || ''));
    if (!cur) throw err(404, 'No se encontró la cuenta');
    const pagos = db.prepare('SELECT 1 FROM pagos WHERE cxp_id=? LIMIT 1').get(cur.id);
    if (pagos) db.prepare("UPDATE cxp SET estado='anulada' WHERE id=?").run(cur.id);
    else db.prepare('DELETE FROM cxp WHERE id=?').run(cur.id);
    return send(res, 200, { ok: true });
  }
  if (route === 'porcobrar') {
    const hoy = diaLocal(Date.now()); const out = {};
    for (const k of Object.keys(NEGOCIOS)) { const n = leerNegocio(k, hoy, hoy); out[k] = { nombre: n.nombre, ok: n.ok, error: n.error, creditos: n.creditos }; }
    return send(res, 200, out);
  }
  if (route === 'negocios' && req.method === 'GET') {
    const hoy = diaLocal(Date.now());
    const out = Object.fromEntries(Object.keys(NEGOCIOS).map(k => {
      const n = leerNegocio(k, hoy, hoy);
      return [k, { nombre: n.nombre, ruta: n.ruta, personalizada: !!CFG.negocios[k], defecto: NEGOCIOS[k].defecto, ok: n.ok, error: n.error, actualizado: n.actualizado }];
    }));
    return send(res, 200, out);
  }
  if (route === 'negocios' && req.method === 'POST') {
    const b = await leerCuerpo(req);
    for (const k of Object.keys(NEGOCIOS)) if (k in b) {
      let p = texto(b[k], 400).replace(/^"|"$/g, '');
      if (p && fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        const nombre = path.basename(NEGOCIOS[k].defecto);
        p = [path.join(p, nombre), path.join(p, 'datos', nombre)].find(x => fs.existsSync(x)) || path.join(p, nombre);
      }
      CFG.negocios[k] = p;
    }
    guardarCfg();
    return send(res, 200, { ok: true });
  }
  if (route === 'pin' && req.method === 'POST') {
    const b = await leerCuerpo(req); const [sal, h] = String(meta('pin') || ':').split(':');
    if (hashPin(String(b.actual || ''), sal) !== h) throw err(400, 'El PIN actual no es correcto');
    if (!/^\d{4,8}$/.test(String(b.nuevo || ''))) throw err(400, 'El PIN nuevo debe tener de 4 a 8 números');
    const s2 = crypto.randomBytes(16).toString('hex'); setMeta('pin', s2 + ':' + hashPin(String(b.nuevo), s2));
    db.prepare('DELETE FROM sesiones WHERE token<>?').run(u.token);
    return send(res, 200, { ok: true });
  }
  if (route === 'respaldo' && req.method === 'POST') { const n = respaldo('manual'); if (!n) throw err(500, 'No se pudo crear el respaldo'); return send(res, 200, { ok: true, nombre: n, carpeta: BK_DIR }); }
  if (route === 'respaldos') {
    const files = fs.readdirSync(BK_DIR).filter(f => /^finanzas_.*\.db$/.test(f)).sort().reverse();
    return send(res, 200, { carpeta: BK_DIR, extra: CFG.carpetaRespaldoExtra || '', respaldos: files.slice(0, 10) });
  }
  if (route === 'actualizacion') {
    if (req.method === 'POST') await revisarActualizacion(true);
    return send(res, 200, { version: VERSION, ...UPD });
  }
  if (route === 'exportar') {
    const { desde, hasta } = rangoDe(url);
    const { movimientos: ms } = movimientos(desde, hasta);
    const filas = [['Fecha', 'Tipo', 'Origen', 'Categoría', 'Descripción', 'Cuenta', 'Monto'].join(';')];
    for (const m of ms.slice().reverse()) filas.push([m.fecha, m.tipo === 'ingreso' ? 'Ingreso' : 'Egreso', NOMBRE_ORIGEN[m.origen] || m.origen, m.categoria, m.descripcion, m.cuenta,
      (m.tipo === 'egreso' ? -m.monto : m.monto).toFixed(2)].map(csv).join(';'));
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="mis_finanzas_${desde}_a_${hasta}.csv"` });
    return res.end('﻿' + filas.join('\r\n'));
  }
  throw err(404, 'No encontrado');
}

const HOST_OK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!HOST_OK.test(String(req.headers.host || ''))) { res.writeHead(403); return res.end('Solo desde esta computadora'); }
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'POST' && req.headers.origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(req.headers.origin)) throw err(403, 'Origen no permitido');
      return await api(req, res, url);
    }
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

/* ---------------- actualizaciones automáticas (desde GitHub) ---------------- */
const PEND = path.join(BASE, 'actualizacion_pendiente');
const ANT = path.join(BASE, 'version_anterior');
const UPD = { estado: 'sin revisar', ultimaRevision: null, disponible: null, error: null };
const PROTEGIDOS = new Set(['config.json']);
const NOMBRE_OK = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,80}\.(js|html|vbs|ps1|bat|txt|md|ico)$/;
function cmpVer(a, b) { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; }
let revisando = false;
async function revisarActualizacion(manual) {
  if (revisando) return; revisando = true;
  try {
    const base = process.env.MF_UPD_BASE || `https://raw.githubusercontent.com/${REPO_ACTUALIZACIONES}/main/${CARPETA_ACTUALIZACIONES}`;
    const r = await fetch(base + 'version.json?t=' + Date.now(), { signal: AbortSignal.timeout(20000), cache: 'no-store' });
    if (!r.ok) throw new Error('No se pudo leer la versión publicada (' + r.status + ')');
    const man = await r.json();
    UPD.ultimaRevision = new Date().toISOString(); UPD.error = null;
    if (!man.version || cmpVer(man.version, VERSION) <= 0) { UPD.estado = 'al día'; UPD.disponible = null; return; }
    const fallidas = fs.readdirSync(DATA_DIR).filter(f => /^actualizacion_fallida_\d+\.json$/.test(f)).map(f => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')).a; } catch (_) { return null; } });
    if (fallidas.includes(man.version)) { UPD.estado = `la versión ${man.version} falló al iniciar y se omitió`; return; }
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
    aplicarActualizacion();
  } catch (e) {
    UPD.error = e.name === 'TimeoutError' || /fetch failed/i.test(e.message) ? 'Sin internet; se intentará más tarde' : e.message;
    UPD.estado = 'error'; if (manual) log('Actualización: ' + UPD.error);
  } finally { revisando = false; }
}
function aplicarActualizacion() {
  let man; try { man = JSON.parse(fs.readFileSync(path.join(PEND, 'version.json'), 'utf8')); } catch (_) { return false; }
  if (cmpVer(man.version, VERSION) <= 0) { fs.rmSync(PEND, { recursive: true, force: true }); return false; }
  if (!process.env.MF_LANZADOR) { UPD.estado = 'lista: se instalará al reiniciar la computadora'; return false; }
  try {
    respaldo('antes de actualizar a ' + man.version);
    fs.rmSync(ANT, { recursive: true, force: true }); fs.mkdirSync(ANT);
    for (const f of man.archivos) { const actual = path.join(BASE, f.nombre); if (fs.existsSync(actual)) fs.copyFileSync(actual, path.join(ANT, f.nombre)); }
    for (const f of man.archivos) fs.copyFileSync(path.join(PEND, f.nombre), path.join(BASE, f.nombre));
    fs.writeFileSync(path.join(DATA_DIR, 'actualizacion_reciente.json'), JSON.stringify({ de: VERSION, a: man.version, fecha: new Date().toISOString() }));
    fs.rmSync(PEND, { recursive: true, force: true });
    log(`Actualizado de ${VERSION} a ${man.version}. Reiniciando...`);
    UPD.estado = 'instalando ' + man.version;
    setTimeout(() => { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch (_) {} process.exit(75); }, 800);
    return true;
  } catch (e) { UPD.estado = 'error'; UPD.error = 'No se pudo instalar: ' + e.message; log(UPD.error); return false; }
}

server.on('error', e => {
  if (e.code === 'EADDRINUSE') { log('Mis Finanzas ya está funcionando en el puerto', CFG.puerto); process.exit(0); }
  log('ERROR del servidor:', e.message); process.exit(1);
});
server.listen(CFG.puerto, '127.0.0.1', () => {
  log(`Mis Finanzas v${VERSION} funcionando en http://localhost:${CFG.puerto}`);
  for (const k of Object.keys(NEGOCIOS)) log(`${NEGOCIOS[k].nombre}: ${fs.existsSync(rutaNegocio(k)) ? 'enlazado' : 'no encontrado'} (${rutaNegocio(k)})`);
  respaldo('inicio');
  setInterval(() => respaldo('automático'), Math.max(0.5, Number(CFG.horasEntreRespaldos) || 6) * 3600 * 1000);
  if (CFG.actualizacionesAutomaticas !== false && !process.env.MF_SIN_ACTUALIZAR) {
    setTimeout(() => revisarActualizacion(false), 60 * 1000);
    setInterval(() => revisarActualizacion(false), 60 * 60 * 1000);
  }
});
