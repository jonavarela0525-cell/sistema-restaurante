'use strict';
/*
 * Impresión directa en impresoras térmicas (ESC/POS), sin pasar por el navegador:
 * el ticket sale del largo exacto, sin márgenes y con corte automático.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');

/* ---------------- PNG -> mapa de puntos blanco/negro ---------------- */
function leerPNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('No es PNG');
  let p = 8, w = 0, h = 0, prof = 8, tipo = 0, inter = 0; const idat = []; let pal = null, trns = null;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), t = buf.toString('latin1', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); prof = d[8]; tipo = d[9]; inter = d[12]; }
    else if (t === 'PLTE') pal = d; else if (t === 'tRNS') trns = d; else if (t === 'IDAT') idat.push(d); else if (t === 'IEND') break;
    p += 12 + len;
  }
  if (inter) throw new Error('PNG entrelazado no soportado');
  const canales = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[tipo];
  const bpp = Math.max(1, (canales * prof) >> 3), fila = Math.ceil(w * canales * prof / 8);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(fila * h); let prev = Buffer.alloc(fila);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (fila + 1)], src = raw.subarray(y * (fila + 1) + 1, (y + 1) * (fila + 1)), cur = out.subarray(y * fila, (y + 1) * fila);
    for (let x = 0; x < fila; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[x] = v & 255;
    }
    prev = cur;
  }
  const negro = new Uint8Array(w * h); // 1 = punto negro
  const muestra = (fila0, x, i) => {
    if (prof === 8) return fila0[x * canales + i];
    if (prof === 16) return fila0[(x * canales + i) * 2];
    const bits = prof, porByte = 8 / bits, byte = fila0[Math.floor(x / porByte)], sh = 8 - bits * (x % porByte + 1);
    const v = (byte >> sh) & ((1 << bits) - 1); return tipo === 3 ? v : Math.round(v * 255 / ((1 << bits) - 1));
  };
  for (let y = 0; y < h; y++) {
    const f0 = out.subarray(y * fila, (y + 1) * fila);
    for (let x = 0; x < w; x++) {
      let r, g, b, al = 255;
      if (tipo === 0) { r = g = b = muestra(f0, x, 0); }
      else if (tipo === 4) { r = g = b = muestra(f0, x, 0); al = muestra(f0, x, 1); }
      else if (tipo === 2) { r = muestra(f0, x, 0); g = muestra(f0, x, 1); b = muestra(f0, x, 2); }
      else if (tipo === 6) { r = muestra(f0, x, 0); g = muestra(f0, x, 1); b = muestra(f0, x, 2); al = muestra(f0, x, 3); }
      else if (tipo === 3) { const i = muestra(f0, x, 0); r = pal[i * 3]; g = pal[i * 3 + 1]; b = pal[i * 3 + 2]; if (trns && i < trns.length) al = trns[i]; }
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      negro[y * w + x] = al > 127 && lum < 128 ? 1 : 0;
    }
  }
  return { w, h, negro };
}
function logoRaster(dataUrl, ancho) {
  const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const img = leerPNG(Buffer.from(m[1], 'base64'));
  // recortar bordes blancos
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) if (img.negro[y * img.w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const W = Math.min(ancho, cw * 4), H = Math.max(1, Math.round(ch * W / cw));
  const bpl = Math.ceil(W / 8), datos = Buffer.alloc(bpl * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = x0 + Math.floor(x * cw / W), sy = y0 + Math.floor(y * ch / H);
    if (img.negro[sy * img.w + sx]) datos[y * bpl + (x >> 3)] |= 0x80 >> (x & 7);
  }
  return Buffer.concat([Buffer.from([0x1d, 0x76, 0x30, 0, bpl & 255, bpl >> 8, H & 255, H >> 8]), datos]);
}

/* ---------------- texto ---------------- */
const REEMPLAZOS = { '→': '->', '…': '...', '“': '"', '”': '"', '‘': "'", '’': "'", '–': '-', '—': '-', '•': '*', '✓': 'v' };
function codificar(s, acentos) {
  s = String(s ?? '');
  if (!acentos) s = s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ñ/g, 'n').replace(/Ñ/g, 'N').replace(/[¡¿]/g, '');
  const out = [];
  for (const ch of s) {
    const r = REEMPLAZOS[ch]; if (r) { for (const c of r) out.push(c.charCodeAt(0)); continue; }
    const c = ch.charCodeAt(0);
    out.push(c < 128 ? c : (c >= 0xa0 && c <= 0xff && acentos ? c : 63)); // Windows-1252 / Latin-1
  }
  return Buffer.from(out);
}
function partir(texto, ancho) {
  const palabras = String(texto ?? '').split(/\s+/).filter(Boolean); const lineas = []; let l = '';
  for (let p of palabras) {
    while (p.length > ancho) { if (l) { lineas.push(l); l = ''; } lineas.push(p.slice(0, ancho)); p = p.slice(ancho); }
    if (!l) l = p; else if ((l + ' ' + p).length <= ancho) l += ' ' + p; else { lineas.push(l); l = p; }
  }
  if (l) lineas.push(l);
  return lineas.length ? lineas : [''];
}
const n2 = v => (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

class Ticket {
  constructor(cols, acentos) { this.cols = cols; this.acentos = acentos; this.b = [Buffer.from([0x1b, 0x40, 0x1b, 0x74, 16, 0x1b, 0x33, 26])]; } // interlineado compacto (26 puntos ≈ 3.2 mm)
  raw(...bytes) { this.b.push(Buffer.from(bytes)); return this; }
  txt(s) { this.b.push(codificar(s, this.acentos)); return this; }
  ln(s = '') { return this.txt(s).raw(0x0a); }
  centro() { return this.raw(0x1b, 0x61, 1); }
  izq() { return this.raw(0x1b, 0x61, 0); }
  negrita(on) { return this.raw(0x1b, 0x45, on ? 1 : 0); }
  tam(w, h) { return this.raw(0x1d, 0x21, ((w - 1) << 4) | (h - 1), 0x1b, 0x33, h > 1 ? 52 : 26); }
  linea(c = '-') { return this.ln(c.repeat(this.cols)); }
  dos(izq, der, cols = this.cols) {
    der = String(der); const ancho = Math.max(4, cols - der.length - 1);
    const ls = partir(izq, ancho);
    ls.forEach((l, i) => this.ln(i === 0 ? l.padEnd(cols - der.length) + der : l));
    return this;
  }
  parrafo(s, cols = this.cols) { partir(s, cols).forEach(l => this.ln(l)); return this; }
  imagen(buf) { if (buf) this.b.push(buf); return this; }
  cortar() { return this.raw(0x1d, 0x56, 0x42, 0); } // avanza lo justo hasta la cuchilla y corta
  bytes() { return Buffer.concat(this.b); }
}

/* ---------------- formatos ---------------- */
function fechaCorta(d) { if (!d) return '-'; const [y, m, dd] = String(d).split('-'); return dd && m ? `${dd}/${m}/${y}` : String(d); }
function horaHN(iso) { const d = new Date(iso); const z = n => String(n).padStart(2, '0'); return `${z(d.getDate())}/${z(d.getMonth() + 1)}/${d.getFullYear()} ${z(d.getHours())}:${z(d.getMinutes())}`; }

function factura(f, o) {
  const t = new Ticket(o.cols, o.acentos); const e = f.emisor || {}; const C = o.cols;
  t.centro();
  if (o.logo) t.imagen(o.logo);
  t.negrita(1).tam(1, 2).parrafo(e.nombre || 'Restaurante').tam(1, 1).negrita(0);
  if (e.razon) t.parrafo(e.razon);
  const id = [e.rtn && 'RTN ' + e.rtn, e.telefono && 'Tel ' + e.telefono].filter(Boolean).join(' - ');
  if (id) t.parrafo(id);
  if (e.direccion) t.parrafo(e.direccion);
  t.izq().linea();
  t.centro().negrita(1).ln((f.fiscal ? 'FACTURA ' : 'COMPROBANTE ') + f.numero).negrita(0);
  if (f.fiscal) t.ln('CAI ' + (e.cai || ''));
  if (f.anulada) t.negrita(1).ln('*** ANULADA ***').negrita(0);
  t.izq().ln(horaHN(f.fecha) + ' - ' + (f.mesa || ''));
  if ((f.cliente && f.cliente !== 'Consumidor Final') || f.rtn) t.parrafo('Cliente: ' + (f.cliente || '') + (f.rtn ? ' - RTN ' + f.rtn : ''));
  if (f.metodo === 'Crédito') t.negrita(1).parrafo(`CRÉDITO ${f.plazo} días - vence ${fechaCorta(f.vence)}`).negrita(0);
  t.linea();
  for (const it of f.items || []) {
    const marca = Number(it.tasa) === 18 ? '*' : Number(it.tasa) === 0 ? '(E)' : '';
    t.dos(`${it.cant}x ${it.nombre}${marca}`, n2(it.precio * it.cant));
    if (it.nota) t.ln('   (' + it.nota + ')');
  }
  t.linea();
  if (f.fiscal) {
    const half = Math.floor(C / 2);
    const par = (a, av, b, bv) => t.ln((a.padEnd(half - n2(av).length) + n2(av)).padEnd(half) + ' ' + (b.padEnd(C - half - 1 - n2(bv).length) + n2(bv)));
    par('Exonerado', 0, 'Exento', f.exento); par('Grav.15%', f.gravado15, 'ISV 15%', f.isv15); par('Grav.18%', f.gravado18, 'ISV 18%', f.isv18);
  } else {
    if (f.exento) t.dos('Exento', n2(f.exento));
    if (f.gravado15) t.dos('Gravado 15%', n2(f.gravado15)).dos('ISV 15%', n2(f.isv15));
    if (f.gravado18) t.dos('Gravado 18%', n2(f.gravado18)).dos('ISV 18%', n2(f.isv18));
  }
  if (f.servicio) t.dos('Servicio ' + f.servicioPct + '%', n2(f.servicio));
  t.negrita(1).tam(1, 2).dos('TOTAL L', n2(f.totalPagar)).tam(1, 1).negrita(0);
  if (f.metodo === 'Crédito') t.dos('Saldo pendiente', n2(f.saldo));
  else t.ln(`${f.metodo} ${n2(f.recibido)}${f.metodo === 'Efectivo' && f.cambio ? ' - Cambio ' + n2(f.cambio) : ''}`);
  if (f.metodo === 'Crédito') t.ln().ln().ln('Firma: ' + '_'.repeat(Math.max(10, C - 8)));
  if (f.fiscal) {
    t.linea();
    t.parrafo(`Rango: ${e.prefijo}${String(e.rangoDesde).padStart(8, '0')} al ${e.prefijo}${String(e.rangoHasta).padStart(8, '0')}`);
    t.ln('Fecha límite de emisión: ' + (e.fechaLimite || '-')).ln('Original: cliente / Copia: emisor');
  }
  t.linea().centro();
  if (e.leyenda) t.parrafo(e.leyenda);
  t.ln('¡Gracias por su visita!').izq();
  return t.cortar().bytes();
}
function comanda(c, o) {
  const t = new Ticket(o.cols, o.acentos);
  t.centro().negrita(1).tam(2, 2).parrafo(c.mesa || '', Math.floor(o.cols / 2)).tam(1, 1);
  if (c.cliente) t.tam(1, 2).parrafo(c.cliente).tam(1, 1);
  t.negrita(0).ln(`#${c.numero} - ${horaHN(c.hora).slice(11)} - ${c.mesero || ''}`).izq().linea();
  for (const l of c.lineas || []) {
    if (l.cambioNota) { t.negrita(1).parrafo('CAMBIO: ' + l.nombre).negrita(0).parrafo('  -> ' + (l.nota || '(sin nota)')); continue; }
    if (l.cant < 0) { t.raw(0x1d, 0x42, 1).negrita(1).tam(1, 2).parrafo(` ANULAR ${-l.cant} x ${l.nombre} `).tam(1, 1).negrita(0).raw(0x1d, 0x42, 0); continue; }
    t.negrita(1).tam(1, 2).parrafo(`${l.cant} x ${l.nombre}`).tam(1, 1).negrita(0);
    if (l.nota) t.parrafo('  -> ' + l.nota);
  }
  return t.cortar().bytes();
}
function texto(s, o) {
  const t = new Ticket(o.cols, o.acentos);
  if (o.logo) t.centro().imagen(o.logo).izq();
  for (const linea of String(s || '').split('\n')) t.parrafo(linea || ' ');
  return t.cortar().bytes();
}
function prueba(o, nombreNegocio) {
  const t = new Ticket(o.cols, o.acentos);
  t.centro(); if (o.logo) t.imagen(o.logo);
  t.negrita(1).tam(1, 2).ln(nombreNegocio || 'Restaurante').tam(1, 1).ln('PRUEBA DE IMPRESIÓN').negrita(0).izq().linea();
  t.ln('Columnas: ' + o.cols + (o.acentos ? ' - con acentos: áéíóú ñ ¡¿' : ' - sin acentos'));
  t.ln('1234567890'.repeat(Math.ceil(o.cols / 10)).slice(0, o.cols));
  t.dos('1x Producto de prueba', '100.00').negrita(1).dos('TOTAL L', '100.00').negrita(0).linea();
  t.parrafo('Si la línea de números cabe completa en un renglón y el papel se cortó solo, la impresora está lista.');
  return t.cortar().bytes();
}

/* ---------------- envío a Windows ---------------- */
function powershell(args, timeout) {
  return new Promise((res, rej) => {
    if (process.platform !== 'win32') return rej(new Error('La impresión directa solo funciona en Windows'));
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'imprimir.ps1'), ...args],
      { windowsHide: true, timeout: timeout || 30000, encoding: 'utf8', maxBuffer: 1 << 20 },
      (err, stdout, stderr) => { if (err && !stdout) return rej(new Error((stderr || err.message || '').trim().slice(0, 300) || 'Error de PowerShell')); res(String(stdout || '').trim()); });
  });
}
async function listarImpresoras() {
  const out = await powershell(['-Accion', 'listar'], 20000);
  let l = []; try { l = JSON.parse(out.replace(/^﻿/, '') || '[]'); } catch (_) { throw new Error('No se pudo leer la lista de impresoras'); }
  return (Array.isArray(l) ? l : [l]).filter(Boolean);
}
let cola = Promise.resolve();
function enviar(nombre, bytes, dirTmp) {
  const tarea = cola.then(async () => {
    const f = path.join(dirTmp, 'ticket_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.bin');
    fs.writeFileSync(f, bytes);
    try {
      const r = await powershell(['-Accion', 'imprimir', '-Impresora', nombre, '-Archivo', f], 30000);
      const ult = r.split(/\r?\n/).pop();
      if (ult !== 'OK') throw new Error(ult || 'La impresora no respondió');
    } finally { try { fs.unlinkSync(f); } catch (_) {} }
  });
  cola = tarea.catch(() => {});
  return tarea;
}

module.exports = { factura, comanda, texto, prueba, logoRaster, listarImpresoras, enviar, leerPNG };
