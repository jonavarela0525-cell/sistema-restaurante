'use strict';
/*
 * Lanzador del Mis Finanzas.
 * Mantiene el servidor funcionando: si se cierra por un error lo vuelve a abrir,
 * y después de una actualización automática lo reinicia con la versión nueva.
 * Si la versión nueva falla al arrancar, regresa sola a la versión anterior.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const BASE = __dirname;
const DATA = path.join(BASE, 'datos');
fs.mkdirSync(DATA, { recursive: true });
const LOG = path.join(DATA, 'registro.log');
const MARCA = path.join(DATA, 'actualizacion_reciente.json');
function log(m) { const l = new Date().toISOString() + ' [lanzador] ' + m; console.log(l); try { fs.appendFileSync(LOG, l + '\n'); } catch (_) {} }

let inicio = 0, fallosRapidos = 0;

function restaurarAnterior() {
  const dir = path.join(BASE, 'version_anterior');
  if (!fs.existsSync(dir) || !fs.existsSync(MARCA)) return false;
  try {
    for (const f of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, f), path.join(BASE, f));
    fs.renameSync(MARCA, path.join(DATA, 'actualizacion_fallida_' + Date.now() + '.json'));
    log('La versión nueva no arrancó. Se restauró la versión anterior.');
    return true;
  } catch (e) { log('No se pudo restaurar la versión anterior: ' + e.message); return false; }
}

function iniciar() {
  inicio = Date.now();
  const hijo = spawn(process.execPath, ['--no-warnings', path.join(BASE, 'server.js')], {
    cwd: BASE, stdio: 'inherit', env: { ...process.env, MF_LANZADOR: '1' }, windowsHide: true,
  });
  hijo.on('exit', code => {
    if (code === 0) { process.exit(0); }            // cierre normal o ya había otro sistema abierto
    if (code === 75) { fallosRapidos = 0; log('Reiniciando con la versión nueva...'); return setTimeout(iniciar, 400); }
    const rapido = Date.now() - inicio < 20000;
    fallosRapidos = rapido ? fallosRapidos + 1 : 0;
    log(`El servidor se cerró (código ${code}). Reintentando...`);
    if (fallosRapidos >= 2 && restaurarAnterior()) fallosRapidos = 0;
    setTimeout(iniciar, Math.min(30000, 1000 + fallosRapidos * 2000));
  });
  // si arrancó bien un buen rato después de actualizar, la actualización queda confirmada
  setTimeout(() => { if (fs.existsSync(MARCA) && Date.now() - inicio >= 60000) { try { fs.unlinkSync(MARCA); } catch (_) {} } }, 61000);
}

function salir() { process.exit(0); }
process.on('SIGINT', salir); process.on('SIGTERM', salir);
iniciar();
