/**
 * Point d'entrée Vercel.
 * Vercel ne peut pas faire tourner le serveur complet (SQLite, yt-dlp, ffmpeg,
 * bot Telegram) : on n'y sert que le mode vitrine (SHOWCASE_MODE=1).
 * En local, utiliser `npm start` (server.js + bot.js), ce fichier est ignoré.
 */
'use strict';

const { isShowcase, createShowcaseApp } = require('../showcase');

module.exports = isShowcase()
  ? createShowcaseApp()
  : (req, res) => {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      res.end('Ce déploiement nécessite SHOWCASE_MODE=1.');
    };
