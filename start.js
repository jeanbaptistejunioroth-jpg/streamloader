/**
 * Lanceur cross-platform — démarre le serveur Express ET le bot Telegram.
 * ─────────────────────────────────────────────────────────────────
 * Problème : sur Windows (cmd.exe), `node server.js & node bot.js`
 * (l'ancien script npm start) exécute les commandes EN SÉQUENCE : le
 * shell reste bloqué sur server.js et bot.js ne démarre JAMAIS.
 * Ce lanceur spawn les deux processus EN PARALLÈLE, quel que soit l'OS.
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');

const children = [];

function start(name, file) {
  const child = spawn(process.execPath, [path.join(__dirname, file)], {
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => {
    console.log(`[start.js] ${name} terminé (code=${code}, signal=${signal || 'none'})`);
  });
  child.on('error', (err) => {
    console.error(`[start.js] Impossible de lancer ${name} :`, err.message);
  });
  children.push(child);
  return child;
}

// Serveur web principal
start('server.js', 'server.js');
// Bot Telegram
start('bot.js', 'bot.js');

function shutdown() {
  console.log('\n[start.js] Arrêt des processus…');
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  }
  // Petit délai puis sortie forcée si nécessaire
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => {
  for (const child of children) {
    try { child.kill(); } catch { /* ignore */ }
  }
});
