/**
 * Mode vitrine — activé uniquement par SHOWCASE_MODE=1 (défini sur Vercel).
 * ─────────────────────────────────────────────────────────────────
 * Le site reste visible (accueil + pages légales) mais n'est pas utilisable :
 *   • toutes les routes /api/*        → 503 JSON
 *   • toute autre page non autorisée  → redirection 302 vers l'accueil
 *   • en-tête X-Robots-Tag "noindex, nofollow" sur toutes les réponses
 *
 * En local (SHOWCASE_MODE absent), rien de ce fichier n'est utilisé et le
 * serveur complet (server.js) reste 100 % fonctionnel.
 */

'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');

const PUBLIC_DIR = path.join(__dirname, 'public');
const HOME_FILE = path.join(PUBLIC_DIR, 'index.html');

const isShowcase = () => process.env.SHOWCASE_MODE === '1';

// Pages et ressources visibles en mode vitrine
const ALLOWED_PAGES = new Set([
  '/',
  '/index.html',
  '/cgv-cgu.html',
  '/confidentialite.html',
  '/mentions-legales.html',
  '/llms.txt',
  '/robots.txt',
]);
const ALLOWED_PREFIXES = ['/assets/'];

const SHOWCASE_BANNER = `
<div id="showcase-banner" role="status" style="position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;max-width:calc(100% - 32px);padding:10px 16px;border-radius:999px;background:#17171A;color:#fff;font:500 14px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25);text-align:center">
  Version de démonstration — les téléchargements, comptes et paiements sont désactivés.
</div>`;

let homeHtmlCache = null;
function homeHtml() {
  if (homeHtmlCache === null) {
    const html = fs.readFileSync(HOME_FILE, 'utf8');
    homeHtmlCache = html.includes('</body>')
      ? html.replace('</body>', `${SHOWCASE_BANNER}\n</body>`)
      : html + SHOWCASE_BANNER;
  }
  return homeHtmlCache;
}

/** Middleware à placer AVANT toutes les routes. */
function showcaseGuard(req, res, next) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  const p = req.path;

  if (p === '/api' || p.startsWith('/api/')) {
    res.setHeader('Retry-After', '86400');
    return res.status(503).json({
      error: 'Service indisponible : ce site est une version de démonstration.',
      showcase: true,
    });
  }

  if (p === '/robots.txt') {
    return res.type('text/plain').send('User-agent: *\nDisallow: /\n');
  }

  if (p === '/' || p === '/index.html') {
    return res.type('html').send(homeHtml());
  }

  if (ALLOWED_PAGES.has(p) || ALLOWED_PREFIXES.some((pre) => p.startsWith(pre))) {
    return next();
  }

  // Connexion, inscription, espace client, paiement, admin, etc.
  return res.redirect(302, '/');
}

/** App autonome (sans base de données ni yt-dlp) utilisée par Vercel. */
function createShowcaseApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(showcaseGuard);
  app.use(express.static(PUBLIC_DIR, { index: false }));
  app.use((req, res) => res.redirect(302, '/'));
  return app;
}

module.exports = { isShowcase, showcaseGuard, createShowcaseApp };
