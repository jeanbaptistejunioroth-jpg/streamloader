/**
 * StreamLoader Web v2.1 — Production Ready
 * ─────────────────────────────────────────
 * Sécurité   : Rate limiting, CORS strict, tokens de téléchargement signés
 * Robustesse : yt-dlp auto-update, gestion d'erreurs enrichie
 * Temps réel : Progression SSE (Server-Sent Events) authentique
 * Arrêt propre : SIGINT / SIGTERM + nettoyage SQLite + fichiers temporaires
 */

'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { v4: uuid } = require('uuid');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const dns = require('dns').promises;
const axios = require('axios');
const { db, queries } = require('./database');

// ─────────────────────────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────────────────────────

const app = express();

// Derrière un proxy (Railway, Nginx, Render…), req.ip reflète l'IP réelle du client.
// Sans cela, tous les utilisateurs anonymes partagent l'IP du proxy, ce qui rend
// les rate limiters et la limite journalière de 30 téléchargements GLOBAUX.
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || (() => { throw new Error('JWT_SECRET manquant dans .env'); })();
// Restreint explicitement l'algorithme accepté (défense en profondeur contre
// une éventuelle confusion d'algorithme si le code évolue un jour).
const JWT_VERIFY_OPTS = { algorithms: ['HS256'] };
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const IS_PROD = process.env.NODE_ENV === 'production';
const PRICE_FCFA = 1200;
const GENIUSPAY_WEBHOOK_SECRET = process.env.GENIUSPAY_WEBHOOK_SECRET || '';
const AD_REDIRECT_URL = process.env.AD_REDIRECT_URL || '';

// Codes des bannières publicitaires (ex. Monetag), collés tels quels dans les
// fichiers du dossier ads/. Chaque emplacement a une taille fixe (indiquée dans
// le fichier) et une variante « mobile » optionnelle pour les petits écrans.
// Lus au démarrage : redémarrer le serveur après les avoir modifiés. Les
// commentaires HTML sont ignorés.
const readAdSnippet = (name) => {
  try {
    return fs.readFileSync(path.join(__dirname, 'ads', name), 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim();
  } catch { return ''; }
};
const AD_BANNERS = {
  hero: readAdSnippet('banner-hero.html'),
  heroMobile: readAdSnippet('banner-hero-mobile.html'),
  card: readAdSnippet('banner-card.html'),
  cardMobile: readAdSnippet('banner-card-mobile.html'),
};

// Les domaines de la régie doivent être autorisés par la CSP, sinon le
// navigateur bloque ses scripts. On les déduit du code collé (adresses et noms
// de domaine entre guillemets), plus AD_CSP_EXTRA pour ceux qu'il charge ensuite.
function collectAdOrigins() {
  const hosts = new Set();
  const snippets = Object.values(AD_BANNERS).join('\n');
  for (const m of snippets.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) hosts.add(m[1].toLowerCase());
  for (const m of snippets.matchAll(/['"]([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})['"]/gi)) {
    if (!/\.(js|css|html?|png|jpe?g|gif|svg|webp|json)$/i.test(m[1])) hosts.add(m[1].toLowerCase());
  }
  for (const token of (process.env.AD_CSP_EXTRA || '').split(/[\s,]+/)) {
    const host = token.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) hosts.add(host);
  }
  return [...hosts].map(h => `https://${h}`);
}
const AD_CSP_ORIGINS = collectAdOrigins().join(' ');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const FREE_DAILY_DOWNLOAD_LIMIT = 30;
const FREE_SUBTITLE_DAILY_LIMIT = 5;
// Durée max d'une vidéo pour un compte gratuit (secondes) — les comptes Premium
// n'ont pas de plafond de durée, mais restent soumis à la file d'attente.
const FREE_MAX_DURATION_SEC = 3 * 60 * 60; // 3h
// Téléchargements simultanés du site, dimensionnés pour une bande passante
// d'environ 16 Mo/s : un fichier de plus de 300 Mo compte double, soit 10
// petits fichiers en même temps ou 5 gros. Les autres attendent leur tour.
const DOWNLOAD_CAPACITY_UNITS = 10;
const LARGE_FILE_BYTES = 300 * 1024 * 1024;
const MAX_QUEUED_JOBS = 100;
// Un visiteur du site en attente dont la page n'est plus connectée depuis plus
// de QUEUE_ABSENT_GRACE_MS est sauté (sans perdre sa place : un onglet mis en
// arrière-plan sur mobile peut perdre sa connexion puis se reconnecter). Au-delà
// de QUEUE_ABANDON_MS, la page est considérée comme fermée et il est retiré.
const QUEUE_ABSENT_GRACE_MS = 60 * 1000;
const QUEUE_ABANDON_MS = 30 * 60 * 1000;
const FREE_TRIM_TRIAL_LIMIT = 3;
// Playlists : les vidéos sont téléchargées une par une par le navigateur, via
// la file d'attente normale. Premium : sans quota. Gratuit : une playlist par
// semaine (compte requis), et moins de vidéos par playlist.
const PLAYLIST_MAX_ITEMS_PREMIUM = 100;
const PLAYLIST_MAX_ITEMS_FREE = 20;
// Accepte MM:SS ou H:MM:SS (ex: "00:10", "1:32:07")
const TRIM_TIME_RE = /^\d{1,2}(:\d{2}){1,2}$/;
// Langues de sous-titres supportées (FR, EN, ES, IT, DE + AR)
const SUBTITLE_LANGS = ['fr', 'en', 'es', 'it', 'de', 'ar'];
const SUBSCRIPTION_PLANS = {
  monthly: { months: 1, usd: 1.5 },
  halfyearly: { months: 6, usd: 6 },
  yearly: { months: 12, usd: 10 },
};
const CURRENCY_RATES = {
  USD: 1, EUR: 0.92, XAF: 600, XOF: 600, NGN: 1600, GHS: 15,
  GBP: 0.79, CAD: 1.36, CHF: 0.90, MAD: 10, DZD: 135, TND: 3.1,
  GNF: 8600, CDF: 2800, ZAR: 18, BRL: 5, INR: 83,
};
const FRONTEND_FILE = path.join(__dirname, 'index 1.2.html');

// User-Agent commun à toutes les invocations yt-dlp (analyse + téléchargement + sous-titres).
const YTDLP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ─── Validation des secrets en PRODUCTION ────────────────────────
// On préfère échouer au démarrage plutôt que de servir des tokens signés
// avec une clé faible ou un secret de webhook vide (paiements jamais validés).
const isWeakSecret = (s) => !s || s.length < 32 || /change[_-]?me|CHANGE_MOI|placeholder/i.test(s);
if (IS_PROD && isWeakSecret(JWT_SECRET)) {
  throw new Error('JWT_SECRET trop faible en production. Générez une clé aléatoire de 64+ caractères.');
}
if (IS_PROD && isWeakSecret(GENIUSPAY_WEBHOOK_SECRET)) {
  throw new Error('GENIUSPAY_WEBHOOK_SECRET trop faible en production. Configurez un secret de webhook robuste.');
}

function getPlanAmount(plan, currency) {
  const selectedPlan = SUBSCRIPTION_PLANS[plan];
  const rate = CURRENCY_RATES[currency];
  if (!selectedPlan || !rate) return null;
  const amount = selectedPlan.usd * rate;
  return currency === 'USD' || currency === 'EUR' || currency === 'GBP' || currency === 'CAD' || currency === 'CHF'
    ? Math.round(amount * 100) / 100
    : Math.round(amount);
}

function getTargetHeight(quality) {
  return {
    '4k': 2160,
    '2160p': 2160,
    '1440p': 1440,
    '1080p': 1080,
    '720p': 720,
    '480p': 480,
    '360p': 360,
  }[quality] || 1080;
}

function getVideoFormatSelector(targetHeight) {
  // Ordre de préférence :
  //   1. H.264 (avc1) MP4 + audio M4A (AAC) → LISIBLE PARTOUT et copiable SANS
  //      ré-encodage (finalisation quasi instantanée).
  //   2. N'importe quel MP4 + M4A → remux rapide.
  //   3. Meilleurs flux séparés quelconques → ré-encodage H.264/AAC si nécessaire.
  //   4. Meilleur flux progressif <= hauteur cible.
  const h = targetHeight;
  return [
    `bestvideo[height<=${h}][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${h}]+bestaudio`,
    `best[height<=${h}]`,
  ].join('/');
}

// Dossier temporaire pour les fichiers en cours de téléchargement
const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

/**
 * Balaie TMP_DIR sur le disque (pas seulement la Map en mémoire des jobs) et
 * supprime tout fichier plus vieux que maxAgeMs. Sans ça, un fichier
 * "orphelin" (job perdu suite à un crash/redémarrage du serveur) reste sur le
 * disque indéfiniment — accumulation garantie à moyen terme jusqu'à saturation.
 * Appelé une fois au démarrage (rattrape les restes d'un précédent run) puis
 * périodiquement.
 */
// Un dossier (jobs du bot Telegram) garde le mtime de sa création tant que
// yt-dlp écrit dans un même fichier : on prend la dernière écriture de son
// contenu, sinon un long téléchargement en cours serait supprimé.
function latestMtimeMs(fullPath) {
  const stat = fs.statSync(fullPath);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let latest = stat.mtimeMs;
  for (const child of fs.readdirSync(fullPath)) {
    try { latest = Math.max(latest, latestMtimeMs(path.join(fullPath, child))); } catch { }
  }
  return latest;
}

function sweepStaleTmpFiles(maxAgeMs, activeJobIds = []) {
  let entries;
  try { entries = fs.readdirSync(TMP_DIR); } catch { return; }
  const now = Date.now();
  for (const name of entries) {
    if (activeJobIds.some(id => name.startsWith(id))) continue;
    const fullPath = path.join(TMP_DIR, name);
    try {
      if (now - latestMtimeMs(fullPath) > maxAgeMs) {
        fs.rmSync(fullPath, { recursive: true, force: true });
      }
    } catch { /* fichier disparu entre-temps : ignorer */ }
  }
}
sweepStaleTmpFiles(5 * 60 * 1000);

// ─────────────────────────────────────────────────────────────────
//  CORS — strict en production, permissif en dev
// ─────────────────────────────────────────────────────────────────

const allowedOrigins = [
  APP_URL,
  ...(process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean),
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
];

const corsOptions = {
  // En dev : permissif. En prod : on n'autorise que les origines listées
  // ET on reflète l'origine (jamais `*` + credentials, combinaison interdite par le spec).
  origin: function (origin, callback) {
    if (!IS_PROD) return callback(null, true); // dev : laisser passer
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origine non autorisée par CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Pre-flight

// Garde-fou : le CORS permissif ne doit JAMAIS tourner sur un déploiement
// public. Si NODE_ENV=development (ou absent) mais que APP_URL ne pointe pas
// vers une machine locale, c'est très probablement un .env de dev oublié
// tel quel sur l'hébergeur — on le crie fort dans les logs au démarrage.
if (!IS_PROD && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(APP_URL)) {
  console.warn(
    '\n⚠️  ATTENTION : NODE_ENV n\'est pas "production" mais APP_URL ('
    + APP_URL + ') ne ressemble pas à une adresse locale.\n'
    + '   Le CORS est actuellement PERMISSIF (toute origine acceptée). '
    + 'Si ce serveur est exposé publiquement, mets NODE_ENV=production immédiatement.\n'
  );
}

// ─────────────────────────────────────────────────────────────────
//  MIDDLEWARES GLOBAUX
// ─────────────────────────────────────────────────────────────────

// Headers de sécurité — DOIT être enregistré avant express.static /
// express.json : ces middlewares peuvent répondre eux-mêmes et court-circuiter
// la chaîne, donc un middleware d'en-têtes placé après eux ne s'applique
// jamais aux fichiers statiques (dont la page HTML principale).
// Note CSP : script-src/style-src gardent 'unsafe-inline' car le frontend est
// une unique page HTML avec tout le JS/CSS inline (pas de fichiers séparés) —
// un refactor pour l'éliminer entièrement est un chantier à part. Cette CSP
// reste néanmoins utile : elle bloque le chargement d'un script DISTANT
// injecté (ex. <script src="https://attaquant.tld/x.js">), les <object>/<embed>,
// et le clickjacking (frame-ancestors). Seuls les domaines de la régie
// publicitaire (AD_CSP_ORIGINS) sont ajoutés en plus.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' ${AD_CSP_ORIGINS}`.trim(),
    `frame-src 'self' ${AD_CSP_ORIGINS}`.trim(),
    // fonts.googleapis.com sert la feuille de style @font-face de Google
    // Fonts (Inter) ; fonts.gstatic.com sert les fichiers .woff2 eux-mêmes.
    // Sans ces deux autorisations, la police tombe en silence sur le repli
    // système — aucune erreur visible, juste un rendu légèrement différent.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    `connect-src 'self' ${AD_CSP_ORIGINS}`.trim(),
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  next();
});

// Mode vitrine (SHOWCASE_MODE=1, défini uniquement sur l'hébergement de démo) :
// accueil + pages légales visibles, tout le reste bloqué. Sans la variable,
// ce middleware n'est pas enregistré et le site reste 100 % fonctionnel.
const showcase = require('./showcase');
if (showcase.isShowcase()) app.use(showcase.showcaseGuard);

app.use(express.json({
  limit: '10kb',
  verify: (req, _res, buf) => { req.rawBody = Buffer.from(buf); },
}));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.get('/index.html', (_, res) => res.sendFile(FRONTEND_FILE));
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────────
//  RATE LIMITERS
// ─────────────────────────────────────────────────────────────────

// Limiteur global — protection DoS de base
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes. Réessaie dans 15 minutes.' },
});
app.use('/api/', globalLimiter);

// Limiteur analyse — 15 analyses par minute par IP
const analyzeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: { error: 'Trop d\'analyses. Attends 1 minute.' },
  keyGenerator: (req) => req.ip,
});

// Limiteur téléchargement — 8 téléchargements par minute par IP
const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  message: { error: 'Trop de téléchargements. Attends 1 minute.' },
  keyGenerator: (req) => req.ip,
});

// Limiteur authentification — anti-brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Trop de tentatives. Réessaie dans 15 minutes.' },
  skipSuccessfulRequests: true,
});

// Limiteur avis — les avis sont ouverts sans compte, donc plus exposés au
// spam qu'une route authentifiée. 5/jour par IP suffit largement à un usage
// légitime tout en limitant l'impact d'un abus.
const reviewLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 5,
  message: { error: 'Trop d\'avis envoyés depuis cette adresse aujourd\'hui.' },
  keyGenerator: (req) => req.ip,
});

// Limiteur de l'API externe Premium (/api/v1/*) — basé sur la clé API et non
// l'IP, pour ne pas pénaliser un intégrateur dont le trafic sort d'une IP
// partagée (backend d'entreprise, proxy, etc.).
const apiKeyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Trop de requêtes API. Réessaie dans 1 minute.' },
  keyGenerator: (req) => req.get('x-api-key') || req.ip,
});

// ─────────────────────────────────────────────────────────────────
//  AUTH HELPERS
// ─────────────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer '))
    return res.status(401).json({ error: 'Non authentifié' });
  try {
    const p = jwt.verify(h.split(' ')[1], JWT_SECRET, JWT_VERIFY_OPTS);
    const u = queries.getUserById.get(p.id);
    if (!u) return res.status(401).json({ error: 'Compte introuvable' });
    req.user = u;
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

function optionalAuth(req, res, next) {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) {
    try {
      const p = jwt.verify(h.split(' ')[1], JWT_SECRET, JWT_VERIFY_OPTS);
      req.user = queries.getUserById.get(p.id) || null;
    } catch { req.user = null; }
  } else {
    req.user = null;
  }
  next();
}

/**
 * Protège les routes de modération des avis. Comparaison en temps constant
 * (comme pour la signature webhook) pour éviter une fuite d'information par
 * timing sur le jeton admin.
 */
function requireAdminToken(req, res, next) {
  const provided = req.get('x-admin-token') || '';
  if (!ADMIN_TOKEN || !provided) return res.status(401).json({ error: 'Non autorisé' });
  const a = Buffer.from(provided);
  const b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
}

/**
 * Comme optionalAuth, mais accepte aussi le token via ?token=... en plus du
 * header Authorization. Nécessaire pour /api/progress/:jobId (EventSource) et
 * /api/file/:jobId (lien <a href>) : ces deux appels du frontend ne peuvent
 * pas envoyer de header Authorization personnalisé (limitation native de
 * EventSource et de la navigation via <a>), donc s'appuyer uniquement sur le
 * header casserait le contrôle de propriété pour tout utilisateur connecté.
 */
function optionalAuthHeaderOrQuery(req, res, next) {
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.split(' ')[1]
    : null;
  const token = bearer || req.query.token || null;
  if (token) {
    try {
      const p = jwt.verify(token, JWT_SECRET, JWT_VERIFY_OPTS);
      req.user = queries.getUserById.get(p.id) || null;
    } catch { req.user = null; }
  } else {
    req.user = null;
  }
  next();
}

// ─────────────────────────────────────────────────────────────────
//  CLÉ API PREMIUM (/api/v1/*)
// ─────────────────────────────────────────────────────────────────

/**
 * Génère une nouvelle clé API. Le préfixe "sl_" facilite la reconnaissance
 * de nos clés dans les logs d'un intégrateur. L'authentification se fait via
 * le HASH ; une copie chiffrée permet au propriétaire connecté de la recopier.
 */
function generateApiKey() {
  const raw = 'sl_' + crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const prefix = raw.slice(0, 12) + '…';
  return { raw, hash, prefix, encrypted: encryptApiKey(raw) };
}

// Secret dédié (API_KEY_SECRET) pour que changer JWT_SECRET ne rende pas les
// clés existantes illisibles ; JWT_SECRET sert de repli s'il n'est pas défini.
const API_KEY_CIPHER_KEY = crypto.createHash('sha256')
  .update('streamloader-api-key:' + (process.env.API_KEY_SECRET || JWT_SECRET))
  .digest();

function encryptApiKey(raw) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', API_KEY_CIPHER_KEY, iv);
  const data = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64')).join('.');
}

// null si la clé est illisible (secret changé depuis, ou clé créée avant le chiffrement).
function decryptApiKey(stored) {
  if (!stored) return null;
  try {
    const [iv, tag, data] = stored.split('.').map(s => Buffer.from(s, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', API_KEY_CIPHER_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch { return null; }
}

/**
 * Protège les routes de l'API externe Premium (/api/v1/*). Exige le header
 * `x-api-key`, vérifie qu'il correspond à un compte existant, ET que ce
 * compte a un statut Premium ACTIF au moment précis de la requête.
 *
 * Désactivation automatique : queries.getUserByApiKeyHash recalcule le statut
 * Premium à la volée (expiration de premium_until comprise, cf. database.js).
 * Dès qu'un abonnement expire, cette vérification échoue naturellement au
 * prochain appel — aucune tâche planifiée n'est nécessaire pour "révoquer"
 * la clé, elle cesse simplement de fonctionner.
 */
function verifyPremiumApiKey(req, res, next) {
  const apiKey = req.get('x-api-key');
  if (!apiKey) {
    return res.status(401).json({ error: 'Clé API manquante. Ajoute le header x-api-key.', code: 'API_KEY_MISSING' });
  }
  const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const user = queries.getUserByApiKeyHash.get(hash);
  if (!user) {
    return res.status(401).json({ error: 'Clé API invalide.', code: 'API_KEY_INVALID' });
  }
  if (user.plan !== 'premium') {
    return res.status(403).json({
      error: 'Cette clé API nécessite un abonnement Premium actif. Elle a été désactivée car ton abonnement n\'est plus actif.',
      code: 'PREMIUM_REQUIRED'
    });
  }
  req.user = user;
  req.apiAuth = true;
  next();
}

// ─────────────────────────────────────────────────────────────────
//  yt-dlp UTILITAIRES
// ─────────────────────────────────────────────────────────────────

/**
 * Auto-update yt-dlp au démarrage et toutes les 24h.
 * Tente d'abord `yt-dlp -U`, puis `pip install yt-dlp --upgrade`.
 */
function autoUpdateYtdlp() {
  console.log('[yt-dlp] Vérification des mises à jour...');
  exec('yt-dlp -U', (err, stdout) => {
    if (!err) {
      console.log('[yt-dlp]', stdout.trim().split('\n')[0]);
    } else {
      // Fallback pip
      exec('pip install yt-dlp --upgrade --quiet --break-system-packages', (e2) => {
        if (e2) console.warn('[yt-dlp] Auto-update échoué :', e2.message);
        else console.log('[yt-dlp] Mis à jour via pip');
      });
    }
  });
}

// Premier update au démarrage (sans bloquer)
autoUpdateYtdlp();
// Puis toutes les 24h
const ytdlpUpdateTimer = setInterval(autoUpdateYtdlp, 24 * 60 * 60 * 1000);

/**
 * Protection SSRF : rejette les URL pointant vers une IP privée/réservée
 * (loopback, réseaux privés RFC1918, link-local — dont 169.254.169.254 utilisé
 * par les métadonnées cloud AWS/GCP/Azure). yt-dlp effectue une vraie requête
 * HTTP sortante depuis ce serveur vers l'URL fournie par le client : sans ce
 * filtre, n'importe qui pourrait sonder le réseau interne ou les endpoints de
 * métadonnées cloud via /api/analyze ou /api/download/start.
 */
function isPrivateOrReservedIP(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || a >= 224) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) return true;
    if (lower.startsWith('::ffff:')) return isPrivateOrReservedIP(lower.slice(7));
    return false;
  }
  return true; // format inconnu : on bloque par prudence
}

async function assertPublicHttpUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error('URL invalide'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('URL invalide');

  let addresses;
  try { addresses = await dns.lookup(parsed.hostname, { all: true }); }
  catch { throw new Error('URL invalide'); }

  if (addresses.some(a => isPrivateOrReservedIP(a.address))) {
    throw new Error('URL invalide');
  }
  return parsed;
}

/**
 * Parse le stderr de yt-dlp en message utilisateur lisible.
 */
function parseYtdlpError(stderr = '') {
  const s = stderr.toLowerCase();
  if (s.includes('http error 429') || s.includes('too many requests'))
    return 'La plateforme limite temporairement les requêtes (erreur 429). Patiente quelques minutes puis réessaie.';
  if (s.includes('unable to download video subtitles') || s.includes('video subtitles for'))
    return 'Les sous-titres de cette langue sont indisponibles pour cette vidéo.';
  if (s.includes('private video') || s.includes('video is private'))
    return 'Cette vidéo est privée et inaccessible.';
  if (s.includes('age-restricted') || s.includes('age restriction') || s.includes('confirm your age'))
    return 'Cette vidéo est réservée aux adultes (restriction d\'âge).';
  if (s.includes('not available in your country') || s.includes('geo-blocked'))
    return 'Vidéo non disponible dans ta région.';
  if (s.includes('this video is unavailable') || s.includes('video unavailable'))
    return 'Vidéo indisponible (supprimée ou retirée).';
  if (s.includes('unsupported url') || s.includes('no supported'))
    return 'URL non reconnue ou site non supporté.';
  if (s.includes('copyright') || s.includes('has been removed'))
    return 'Vidéo retirée pour violation de droits d\'auteur.';
  if (s.includes('sign in') || s.includes('login required'))
    return 'Cette vidéo requiert une connexion au compte de la plateforme.';
  if (s.includes('members-only') || s.includes('paid content'))
    return 'Contenu réservé aux membres / payant.';
  if (s.includes('network') || s.includes('connection refused'))
    return 'Erreur réseau. Réessaie dans quelques instants.';
  if (s.includes('http error 403'))
    return 'Accès refusé par la plateforme (erreur 403).';
  if (s.includes('http error 404'))
    return 'Vidéo introuvable (erreur 404). Vérifie l\'URL.';
  return 'Impossible d\'analyser cette vidéo. Vérifie l\'URL et réessaie.';
}

/**
 * Convertit "MM:SS" ou "H:MM:SS" en secondes. Retourne null si invalide.
 */
// "130.74MiB" / "1.2GiB" / "850KiB" (format des lignes de progression yt-dlp) → octets.
function parseSizeToBytes(s) {
  const m = String(s || '').match(/([\d.]+)\s*([KMGT]?)(i?)B/i);
  if (!m) return null;
  const base = m[3] ? 1024 : 1000;
  const power = { '': 0, K: 1, M: 2, G: 3, T: 4 }[m[2].toUpperCase()];
  return parseFloat(m[1]) * Math.pow(base, power);
}

// Taille approximative de ce que yt-dlp va télécharger, d'après l'analyse de la
// vidéo. Retourne null si elle est inconnue (le job comptera alors comme un gros
// fichier jusqu'à ce que yt-dlp annonce la vraie taille).
function estimateDownloadBytes(info, { isAudio, targetHeight, trimSeconds }) {
  if (!info) return null;
  const duration = info.duration || null;
  const sizeOf = f => f.filesize || f.filesize_approx || (f.tbr && duration ? f.tbr * 125 * duration : null);
  const formats = info.formats || [];
  const audio = formats
    .filter(f => f.vcodec === 'none' && f.acodec && f.acodec !== 'none')
    .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];

  let bytes;
  if (isAudio) {
    bytes = audio ? sizeOf(audio) : null;
  } else {
    const video = formats
      .filter(f => f.height && f.height <= targetHeight && f.vcodec && f.vcodec !== 'none')
      .sort((a, b) => (b.height - a.height) || ((b.tbr || 0) - (a.tbr || 0)))[0];
    const videoBytes = video ? sizeOf(video) : null;
    const needsAudio = video && (!video.acodec || video.acodec === 'none');
    bytes = videoBytes == null ? null : videoBytes + ((needsAudio && audio && sizeOf(audio)) || 0);
  }
  if (bytes == null) bytes = info.filesize || info.filesize_approx || null;
  if (bytes != null && trimSeconds && duration) bytes *= Math.min(1, trimSeconds / duration);
  return bytes;
}

function parseTimeToSeconds(t) {
  const parts = String(t).trim().split(':').map(Number);
  if (parts.some(n => Number.isNaN(n))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

/**
 * Parse une ligne de progression yt-dlp.
 * Exemple : "[download]  45.3% of   78.50MiB at    1.23MiB/s ETA 00:45"
 */
function parseYtdlpProgress(line) {
  // Les flux HLS (ex. XVideos) annoncent une taille APPROXIMATIVE avec un "~"
  // ("of ~ 130.74MiB") et souvent "ETA Unknown" tant que le nombre total de
  // fragments n'est pas connu avec certitude — sans le "~?" et l'ETA élargie
  // à autre chose qu'un horaire chiffré, cette ligne ne matchait jamais et la
  // progression restait bloquée à 0% (le téléchargement avançait pourtant
  // bien en arrière-plan).
  const m = line.match(
    /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\s*\S+)\s+at\s+([\d.]+\s*\S+\/s|Unknown\s*\S*)(?:\s+ETA\s+(\S+))?/
  );
  if (m) {
    return {
      percent: parseFloat(m[1]),
      total: m[2].trim(),
      speed: m[3].trim(),
      eta: m[4] || null,
    };
  }
  return null;
}

function probeVideo(filepath) {
  return new Promise((resolve, reject) => {
    const probe = spawn('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,codec_name,profile',
      '-of', 'json', filepath,
    ]);
    let stdout = '';
    let stderr = '';
    probe.stdout.on('data', chunk => { stdout += chunk.toString(); });
    probe.stderr.on('data', chunk => { stderr += chunk.toString(); });
    probe.on('error', reject);
    probe.on('close', code => {
      if (code !== 0) return reject(new Error(stderr || 'ffprobe indisponible.'));
      try {
        const stream = JSON.parse(stdout).streams?.[0];
        if (!stream) throw new Error('Flux vidéo introuvable.');
        resolve(stream);
      } catch (error) {
        reject(error);
      }
    });
  });
}

/**
 * Sonde les flux vidéo ET audio d'un fichier (codec, dimensions) via ffprobe.
 */
function probeStreams(filepath) {
  return new Promise((resolve, reject) => {
    const probe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=index,codec_type,codec_name,width,height,profile',
      '-of', 'json', filepath,
    ]);
    let stdout = '', stderr = '';
    probe.stdout.on('data', chunk => { stdout += chunk.toString(); });
    probe.stderr.on('data', chunk => { stderr += chunk.toString(); });
    probe.on('error', reject);
    probe.on('close', code => {
      if (code !== 0) return reject(new Error(stderr || 'ffprobe indisponible.'));
      try {
        const streams = JSON.parse(stdout).streams || [];
        resolve({
          video: streams.find(s => s.codec_type === 'video') || null,
          audio: streams.find(s => s.codec_type === 'audio') || null,
        });
      } catch (error) { reject(error); }
    });
  });
}

/**
 * Finalise le fichier téléchargé en UNE seule passe ffmpeg :
 *   - copie la vidéo H.264 si elle est déjà au bon format (sinon ré-encodage H.264),
 *   - copie l'audio AAC s'il est déjà compatible iOS (sinon ré-encodage AAC),
 *   - embarque éventuellement un fichier de sous-titres (.srt) en piste mov_text,
 *   - applique `+faststart` pour un démarrage immédiat.
 * Le fast-path (copie vidéo + audio) prend quelques secondes au lieu d'un long ré-encodage.
 */
function finalizeVideo(filepath, targetHeight, subtitlePath = null, subtitleLang = 'und') {
  return new Promise((resolve, reject) => {
    const convertedPath = `${filepath}.converted.mp4`;
    probeStreams(filepath).then(({ video, audio }) => {
      const sourceHeight = Number(video?.height) || 0;
      const videoIsH264 = video?.codec_name === 'h264';
      const audioIsAac = !audio || audio.codec_name === 'aac';
      const needScale = sourceHeight > 0 && sourceHeight > targetHeight;

      const ffmpegArgs = ['-y', '-i', filepath];

      // Sous-titres : deuxième entrée, mappée en piste mov_text (compatible MP4).
      if (subtitlePath) ffmpegArgs.push('-i', subtitlePath);

      // Mappage explicite dès qu'on a plusieurs entrées, pour éviter toute ambiguïté.
      if (subtitlePath) ffmpegArgs.push('-map', '0:v:0', '-map', '0:a:0?', '-map', '1:0');

      // Vidéo : copie si déjà H.264 à la bonne résolution, sinon ré-encodage H.264.
      if (videoIsH264 && !needScale) {
        ffmpegArgs.push('-c:v', 'copy');
      } else {
        if (needScale) ffmpegArgs.push('-vf', `scale=-2:${targetHeight}`);
        ffmpegArgs.push(
          '-c:v', 'libx264', '-profile:v', 'high', '-level', '5.1',
          '-crf', '20', '-pix_fmt', 'yuv420p', '-preset', 'veryfast'
        );
      }

      // Audio : copie si déjà AAC (cas normal), sinon ré-encodage AAC (compatibilité iOS).
      if (audio) {
        ffmpegArgs.push(...(audioIsAac ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']));
      }

      if (subtitlePath) {
        ffmpegArgs.push('-c:s', 'mov_text', '-metadata:s:s:0', `language=${subtitleLang}`);
      }

      ffmpegArgs.push('-movflags', '+faststart', convertedPath);

      const ffmpeg = spawn('ffmpeg', ffmpegArgs);
      let stderr = '';
      ffmpeg.stderr.on('data', chunk => { stderr += chunk.toString(); });
      ffmpeg.on('error', reject);
      ffmpeg.on('close', code => {
        if (code !== 0 || !fs.existsSync(convertedPath)) {
          try { fs.unlinkSync(convertedPath); } catch { }
          return reject(new Error(stderr.slice(-500)));
        }
        try {
          fs.unlinkSync(filepath);
          fs.renameSync(convertedPath, filepath);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    }).catch(reject);
  });
}

// ─── Sous-titres : téléchargement robuste ────────────────────────
// YouTube limite fortement son endpoint de sous-titres (timedtext), en
// particulier pour les légendes AUTO-TRADUITES (ex. « fr » sur une vidéo
// anglophone) : il renvoie très souvent un HTTP 429 « Too Many Requests ».
// Un unique essai échoue donc régulièrement, et la vidéo finissait par être
// livrée SANS sous-titres alors que l'utilisateur les avait demandés.
// On ré-essaie donc plusieurs fois avec un délai croissant jusqu'à obtenir
// un fichier .srt non vide.
const SUBTITLE_MAX_ATTEMPTS = 5;
const SUBTITLE_RETRY_DELAYS_MS = [1500, 3000, 6000, 10000]; // entre les tentatives
const MIN_SUBTITLE_BYTES = 32; // un .srt valide fait toujours plus que ça

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Supprime tout fichier de sous-titres résiduel produit pour cet `outBase`
 * (utile entre deux tentatives pour ne pas confondre un ancien fichier).
 */
function cleanupSubtitleFiles(outBase) {
  const dir = path.dirname(outBase);
  const prefix = path.basename(outBase) + '.';
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(prefix)) {
        try { fs.unlinkSync(path.join(dir, name)); } catch { /* ignore */ }
      }
    }
  } catch { /* dossier illisible : on ignore */ }
}

/**
 * Retrouve le meilleur fichier .srt produit pour une langue donnée.
 * Préfère une correspondance exacte (`<base>.<lang>.srt`), puis une variante
 * régionale (`<base>.<lang>-XX.srt`), puis n'importe quel .srt produit.
 * Un fichier vide (téléchargement interrompu) est rejeté.
 */
function findSubtitleFile(outBase, lang) {
  const dir = path.dirname(outBase);
  const base = path.basename(outBase);
  let names;
  try { names = fs.readdirSync(dir); }
  catch { return null; }

  const srtFiles = names.filter(
    (n) => n.startsWith(base + '.') && n.toLowerCase().endsWith('.srt')
  );
  const chosen =
    srtFiles.find((n) => n === `${base}.${lang}.srt`) ||
    srtFiles.find((n) => n.startsWith(`${base}.${lang}-`)) ||
    srtFiles[0];
  if (!chosen) return null;

  const full = path.join(dir, chosen);
  try {
    if (fs.statSync(full).size < MIN_SUBTITLE_BYTES) return null;
  } catch { return null; }
  return full;
}

/**
 * Détermine si un échec vaut la peine d'être ré-essayé.
 * Les erreurs de throttling / réseau sont ré-essayables ; l'absence pure et
 * simple de sous-titres dans cette langue ne l'est pas.
 */
function isSubtitleErrorRetryable(stderr) {
  const s = String(stderr || '').toLowerCase();
  if (s.includes('no subtitles') || s.includes('there are no subtitles')) return false;
  if (s.includes('requested languages') && s.includes('not available')) return false;
  return true;
}

/**
 * UNE tentative de téléchargement des sous-titres via yt-dlp.
 * Résout { file, retryable } : `file` est le .srt obtenu (ou null).
 */
function attemptSubtitleDownload(url, lang, outBase) {
  return new Promise((resolve) => {
    cleanupSubtitleFiles(outBase);
    let stderr = '';
    const proc = spawn('yt-dlp', [
      '--skip-download',
      '--write-subs', '--write-auto-subs',
      '--sub-langs', lang,
      // Préférence de format puis conversion finale en .srt (compatible mov_text).
      '--sub-format', 'srt/vtt/best',
      '--convert-subs', 'srt',
      '-o', outBase,
      // On conserve les avertissements : ils permettent de distinguer
      // « aucune piste dans cette langue » d'une vraie erreur réseau/429.
      '--no-playlist',
      // Ré-essais internes de yt-dlp (réseau / extraction).
      '--retries', '5',
      '--fragment-retries', '5',
      '--extractor-retries', '2',
      '--sleep-subtitles', '1',
      '--user-agent', YTDLP_UA,
      url,
    ]);
    proc.stdout.on('data', () => { });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', () => resolve({ file: null, retryable: false, stderr }));
    proc.on('close', (code) => {
      const file = findSubtitleFile(outBase, lang);
      // yt-dlp sort en code 0 quand AUCUNE piste n'existe dans la langue
      // demandée (rien à ré-essayer) et en code ≠ 0 pour un échec réel
      // (HTTP 429, erreur réseau, extraction…) qui mérite un nouvel essai.
      const retryable = !file && code !== 0 && isSubtitleErrorRetryable(stderr);
      resolve({ file, retryable, stderr, code });
    });
  });
}

/**
 * Télécharge UNIQUEMENT le fichier de sous-titres dans une langue donnée
 * (best-effort, avec ré-essais). Ne touche JAMAIS à la vidéo : en dernier
 * recours, renvoie null et la vidéo est conservée SANS sous-titres.
 */
async function downloadSubtitleFile(url, lang, outBase) {
  let lastError = '';
  for (let attempt = 1; attempt <= SUBTITLE_MAX_ATTEMPTS; attempt += 1) {
    const { file, retryable, stderr } = await attemptSubtitleDownload(url, lang, outBase);
    if (file) {
      if (attempt > 1) {
        console.log(`[subtitles] '${lang}' récupéré à la tentative ${attempt}/${SUBTITLE_MAX_ATTEMPTS}.`);
      }
      return file;
    }
    lastError = String(stderr || '').trim().split('\n').filter(Boolean).slice(-1)[0] || '';
    if (!retryable) break;
    if (attempt < SUBTITLE_MAX_ATTEMPTS) {
      const pause = SUBTITLE_RETRY_DELAYS_MS[attempt - 1]
        ?? SUBTITLE_RETRY_DELAYS_MS[SUBTITLE_RETRY_DELAYS_MS.length - 1];
      console.warn(`[subtitles] '${lang}' indisponible (tentative ${attempt}/${SUBTITLE_MAX_ATTEMPTS}) — nouvel essai dans ${pause} ms…`);
      await delay(pause);
    }
  }
  if (lastError) console.warn(`[subtitles] '${lang}' non embarqué : ${lastError}`);
  return null;
}

function transcodeAudio(filepath) {
  return new Promise((resolve, reject) => {
    const convertedPath = `${filepath}.converted.mp3`;
    const ffmpeg = spawn('ffmpeg', [
      '-y', '-i', filepath, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', convertedPath,
    ]);
    let stderr = '';
    ffmpeg.stderr.on('data', chunk => { stderr += chunk.toString(); });
    ffmpeg.on('error', reject);
    ffmpeg.on('close', code => {
      if (code !== 0 || !fs.existsSync(convertedPath)) {
        try { fs.unlinkSync(convertedPath); } catch { }
        return reject(new Error(stderr.slice(-500)));
      }
      try {
        fs.unlinkSync(filepath);
        fs.renameSync(convertedPath, filepath);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

/**
 * Extraction d'info via yt-dlp --dump-single-json.
 * - Lien d'une vidéo (même s'il contient aussi une playlist) : renvoie la vidéo
 *   (_type 'video') grâce à --no-playlist.
 * - Lien d'une playlist seule : renvoie la playlist (_type 'playlist') avec ses
 *   entrées « à plat » (titre, durée, lien), sans analyser chaque vidéo —
 *   d'où une réponse en quelques secondes. --playlist-end borne la lecture.
 */
function ytdlpInfo(url) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const proc = spawn('yt-dlp', [
      '--dump-single-json', '--no-warnings', '--no-playlist',
      '--flat-playlist', '--playlist-end', String(PLAYLIST_MAX_ITEMS_PREMIUM + 1),
      '--user-agent', YTDLP_UA,
      url
    ]);
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(parseYtdlpError(stderr)));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error('Réponse yt-dlp invalide. Réessaie.')); }
    });
    proc.on('error', () => reject(new Error(
      'yt-dlp introuvable sur le serveur. Contacte l\'administrateur.'
    )));
  });
}

// ─────────────────────────────────────────────────────────────────
//  STORE DES JOBS DE TÉLÉCHARGEMENT (en mémoire)
// ─────────────────────────────────────────────────────────────────

/**
 * Map : jobId → { status, percent, speed, eta, total,
 *                 filepath, title, ext, userId, createdAt, error }
 */
const downloadJobs = new Map();

// ─── File d'attente des téléchargements du site ──────────────────
// Premium avant gratuits, ordre d'arrivée conservé dans chaque groupe.
// Aucun téléchargement en cours n'est interrompu pour faire de la place.
const downloadQueue = []; // { jobId, premium, start }

const jobWeight = (job) =>
  job.estimatedBytes == null || job.estimatedBytes > LARGE_FILE_BYTES ? 2 : 1;

function usedCapacityUnits() {
  let used = 0;
  for (const job of downloadJobs.values()) if (job.running) used += jobWeight(job);
  return used;
}

// Seuls les visiteurs du site sont suivis en direct : les jobs de l'API
// Premium (suivis par simple interrogation) ne sont jamais considérés absents.
function absentSinceMs(job, now = Date.now()) {
  if (job.source !== 'web') return 0;
  if ((sseClients.get(job.id) || []).length > 0) return 0;
  return now - job.lastSeen;
}
const isAbsent = (job) => absentSinceMs(job) > QUEUE_ABSENT_GRACE_MS;

function notifyQueuePositions() {
  let position = 0;
  for (const entry of downloadQueue) {
    const job = downloadJobs.get(entry.jobId);
    if (!job || isAbsent(job)) continue;
    position += 1;
    job.status = 'queued';
    job.queuePosition = position;
    sseEmit(entry.jobId, { type: 'queued', position, premium: entry.premium });
  }
}

function scheduleDownloads() {
  for (let i = 0; i < downloadQueue.length;) {
    const entry = downloadQueue[i];
    const job = downloadJobs.get(entry.jobId);
    if (!job) { downloadQueue.splice(i, 1); continue; }
    if (isAbsent(job)) { i += 1; continue; } // garde sa place, laisse passer les suivants
    if (usedCapacityUnits() + jobWeight(job) > DOWNLOAD_CAPACITY_UNITS) break;
    downloadQueue.splice(i, 1);
    job.running = true;
    job.status = 'starting';
    job.queuePosition = null;
    entry.start();
  }
  notifyQueuePositions();
}

function dropAbandonedQueuedJobs() {
  const now = Date.now();
  for (let i = downloadQueue.length - 1; i >= 0; i--) {
    const job = downloadJobs.get(downloadQueue[i].jobId);
    if (job && absentSinceMs(job, now) > QUEUE_ABANDON_MS) {
      downloadQueue.splice(i, 1);
      try { queries.updateDownloadStatus.run('error', job.downloadLogId); } catch { }
      downloadJobs.delete(job.id);
    }
  }
}

function enqueueDownload(jobId, premium, start) {
  const entry = { jobId, premium, start };
  const firstFree = premium ? downloadQueue.findIndex(e => !e.premium) : -1;
  if (firstFree === -1) downloadQueue.push(entry);
  else downloadQueue.splice(firstFree, 0, entry);
  scheduleDownloads();
}

function releaseDownloadSlot(jobId) {
  const job = downloadJobs.get(jobId);
  if (job) job.running = false;
  scheduleDownloads();
}

/**
 * Map : jobId → [res (SSE), ...]
 */
const sseClients = new Map();

// Un fichier prêt mais jamais récupéré est supprimé 5 min après la FIN du
// téléchargement (pas après son début : une longue vidéo peut mettre plus de
// 5 min à se télécharger). Les jobs bloqués sont abandonnés après 4h.
const TMP_FILE_TTL_MS = 5 * 60 * 1000;
const STUCK_JOB_MAX_MS = 4 * 60 * 60 * 1000;

const jobCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, job] of downloadJobs) {
    const finished = job.status === 'done' || job.status === 'error';
    const expired = finished
      ? now - (job.finishedAt || job.createdAt) > TMP_FILE_TTL_MS
      : now - job.createdAt > STUCK_JOB_MAX_MS;
    if (expired) {
      if (job.filepath && fs.existsSync(job.filepath)) {
        try { fs.unlinkSync(job.filepath); } catch { }
      }
      downloadJobs.delete(id);
    }
  }
  dropAbandonedQueuedJobs();
  scheduleDownloads(); // rafraîchit aussi les positions affichées
  const runningJobIds = [...downloadJobs]
    .filter(([, job]) => job.status !== 'done' && job.status !== 'error')
    .map(([id]) => id);
  sweepStaleTmpFiles(TMP_FILE_TTL_MS, runningJobIds);
}, 60 * 1000);

// ─── SSE helpers ─────────────────────────────────────────────────

function sseEmit(jobId, data) {
  const clients = sseClients.get(jobId) || [];
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch { }
  }
}

function sseClose(jobId) {
  const clients = sseClients.get(jobId) || [];
  for (const res of clients) {
    try { res.end(); } catch { }
  }
  sseClients.delete(jobId);
}

// ─────────────────────────────────────────────────────────────────
//  ROUTES AUTH
// ─────────────────────────────────────────────────────────────────

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email et mot de passe requis' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Email invalide' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Mot de passe min 6 caractères' });

  try {
    if (queries.getUserByEmail.get(email.toLowerCase()))
      return res.status(409).json({ error: 'Un compte existe déjà avec cet email' });

    const hash = await bcrypt.hash(password, 12); // coût 12 pour la prod
    const id = uuid();
    queries.createUser.run(id, email.toLowerCase(), hash);
    const token = jwt.sign({ id }, JWT_SECRET, { expiresIn: '30d', algorithm: 'HS256' });
    res.status(201).json({
      success: true, token,
      user: queries.getUserById.get(id)
    });
  } catch (e) {
    console.error('[register]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Champs requis' });

  try {
    const user = queries.getUserByEmail.get(email.toLowerCase());
    // Comparaison en temps constant même si user est null (anti-timing)
    const valid = user && await bcrypt.compare(password, user.password);
    if (!valid)
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d', algorithm: 'HS256' });
    res.json({
      success: true, token,
      user: { id: user.id, email: user.email, plan: user.plan, trim_trials_used: user.trim_trials_used, created_at: user.created_at }
    });
  } catch (e) {
    console.error('[login]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// ─── Gestion de la clé API Premium (depuis le site, session JWT normale) ──

// Clé actuelle, accessible uniquement à son propriétaire connecté (session JWT).
app.get('/api/account/api-key', authMiddleware, (req, res) => {
  const info = queries.getApiKeyInfo.get(req.user.id);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    hasKey: Boolean(info?.api_key_prefix),
    prefix: info?.api_key_prefix || null,
    apiKey: decryptApiKey(info?.api_key_encrypted),
    createdAt: info?.api_key_created_at || null,
  });
});

// Génère (ou régénère) la clé — réservé aux abonnés Premium actifs.
// Régénérer invalide immédiatement l'ancienne clé (un seul hash stocké).
app.post('/api/account/api-key', authMiddleware, (req, res) => {
  if (req.user.plan !== 'premium') {
    return res.status(403).json({
      error: 'La génération de clé API est réservée aux abonnés Premium.',
      code: 'PREMIUM_REQUIRED'
    });
  }
  const { raw, hash, prefix, encrypted } = generateApiKey();
  queries.setApiKey.run(hash, prefix, encrypted, req.user.id);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, apiKey: raw, prefix });
});

app.delete('/api/account/api-key', authMiddleware, (req, res) => {
  queries.revokeApiKey.run(req.user.id);
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────
//  ROUTES VIDÉO
// ─────────────────────────────────────────────────────────────────

// ─── Playlists ────────────────────────────────────────────────────
const isYoutubeHost = (hostname) => /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(hostname);

// Identifiant stable d'une playlist : sert au quota hebdomadaire des comptes gratuits.
function playlistKeyFor(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const list = u.searchParams.get('list');
    if (list && isYoutubeHost(u.hostname)) return `yt:${list}`;
    u.hash = '';
    return `url:${u.toString()}`;
  } catch { return `url:${rawUrl}`; }
}

// Lien YouTube « vidéo + playlist » (watch?v=…&list=…) : renvoie le lien de la
// playlist seule, pour proposer de l'ouvrir. Les « mix » automatiques (RD…) et
// les listes privées (WL, LL) ne sont pas de vraies playlists partageables.
function youtubePlaylistUrlOf(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!isYoutubeHost(u.hostname)) return null;
    const list = u.searchParams.get('list');
    if (!list || /^(RD|WL$|LL$)/.test(list)) return null;
    return `https://www.youtube.com/playlist?list=${encodeURIComponent(list)}`;
  } catch { return null; }
}

// Droits « playlist » du visiteur. Premium : sans quota. Gratuit : compte requis
// et une playlist par semaine — la même playlist peut être reprise dans la
// semaine (téléchargement interrompu) sans consommer un nouveau quota.
function getPlaylistAccess(user, playlistKey) {
  if (user?.plan === 'premium') return { plan: 'premium', allowed: true, maxItems: PLAYLIST_MAX_ITEMS_PREMIUM };
  const base = { plan: 'free', maxItems: PLAYLIST_MAX_ITEMS_FREE };
  if (!user) return { ...base, allowed: false, reason: 'LOGIN_REQUIRED' };
  const recent = queries.getRecentPlaylist.get(user.id);
  if (recent && recent.playlist_key !== playlistKey) {
    return { ...base, allowed: false, reason: 'PLAYLIST_LIMIT_REACHED', nextAt: recent.next_at };
  }
  return { ...base, allowed: true, resumed: Boolean(recent) };
}

// GET /api/analyze?url=...
// Extrait en fonction nommée pour être réutilisée telle quelle par l'API
// externe Premium (/api/v1/analyze) sans dupliquer la logique.
const handleAnalyze = async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL manquante' });

  // Validation + protection SSRF (rejette les cibles réseau internes).
  try { await assertPublicHttpUrl(url); }
  catch { return res.status(400).json({ error: 'URL invalide' }); }

  try {
    const data = await ytdlpInfo(url);

    // Lien de playlist : on renvoie la liste des vidéos (pas de formats, ils
    // sont choisis une fois pour toute la playlist côté site).
    if (data._type === 'playlist') {
      const listed = (Array.isArray(data.entries) ? data.entries : []).slice(0, PLAYLIST_MAX_ITEMS_PREMIUM);
      // Les vidéos privées ou supprimées reviennent sans titre : on les écarte.
      const entries = listed
        .filter(e => e && e.title && /^https?:\/\//i.test(e.url || e.webpage_url || ''))
        .map(e => ({
          id: e.id || null,
          title: String(e.title).slice(0, 200),
          duration: e.duration || null,
          url: e.url || e.webpage_url,
        }));
      if (!entries.length) {
        return res.status(400).json({ error: 'Cette playlist est vide, ou ses vidéos ne sont pas accessibles.' });
      }
      const webpage = data.webpage_url || url;
      return res.json({
        success: true,
        playlist: {
          title: data.title || 'Playlist',
          uploader: data.uploader || data.channel || null,
          webpage,
          total: data.playlist_count || listed.length,
          unavailable: listed.length - entries.length,
          entries,
          limits: { free: PLAYLIST_MAX_ITEMS_FREE, premium: PLAYLIST_MAX_ITEMS_PREMIUM },
          access: getPlaylistAccess(req.user, playlistKeyFor(webpage)),
        },
      });
    }

    // Extraire les langues des sous-titres (manuels et auto)
    const manualSubs = Object.keys(data.subtitles || {});
    const autoSubs = Object.keys(data.automatic_captions || {});
    const allSubs = [...new Set([...manualSubs, ...autoSubs])];

    res.json({
      success: true,
      data: {
        title: data.title || 'Sans titre',
        duration: data.duration || null,
        uploader: data.uploader || data.channel || 'Inconnu',
        thumbnail: data.thumbnail || null,
        subtitles: allSubs,
        extractor: data.extractor_key || '?',
        webpage: data.webpage_url || url,
        // Si la vidéo vient d'une playlist YouTube, lien pour ouvrir la playlist entière.
        playlistUrl: youtubePlaylistUrlOf(url),
        // On écarte les storyboards (vcodec "images" / ext mhtml) qui sont sans
        // intérêt et qui, étant en tête de liste, poussaient les formats 4K/1440p
        // hors de la limite de 40 et les rendaient invisibles dans le frontend.
        formats: (data.formats || [])
          .filter(f => f.vcodec !== 'images' && f.ext !== 'mhtml')
          .map(f => ({
            id: f.format_id,
            ext: f.ext || '?',
            height: f.height || null,
            width: f.width || null,
            fps: f.fps || null,
            filesize: f.filesize || f.filesize_approx || null,
            vcodec: f.vcodec !== 'none' ? f.vcodec : null,
            acodec: f.acodec !== 'none' ? f.acodec : null,
            tbr: f.tbr || null,
          }))
          .slice(0, 80),
      }
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};
app.get('/api/analyze', analyzeLimiter, optionalAuth, handleAnalyze);

// POST /api/playlist/start — à appeler avant de télécharger les vidéos d'une
// playlist : vérifie les droits et, pour un compte gratuit, consomme le quota
// hebdomadaire. Les vidéos passent ensuite une par une par /api/download/start
// (file d'attente, limites journalières et de durée habituelles).
app.post('/api/playlist/start', analyzeLimiter, optionalAuth, async (req, res) => {
  const { url, count } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL manquante' });
  try { await assertPublicHttpUrl(url); }
  catch { return res.status(400).json({ error: 'URL invalide' }); }

  const key = playlistKeyFor(url);
  const access = getPlaylistAccess(req.user, key);

  if (!access.allowed && access.reason === 'LOGIN_REQUIRED') {
    return res.status(403).json({
      error: 'Crée un compte gratuit pour télécharger une playlist (une par semaine, ou sans limite avec Premium).',
      code: 'LOGIN_REQUIRED',
    });
  }
  if (!access.allowed) {
    return res.status(403).json({
      error: 'Tu as déjà téléchargé une playlist cette semaine avec ton compte gratuit. Passe au Premium pour des playlists illimitées.',
      code: 'PLAYLIST_LIMIT_REACHED',
      nextAt: access.nextAt,
    });
  }
  if (access.plan === 'free' && !access.resumed) {
    const items = Math.max(1, Math.min(Number(count) || 1, PLAYLIST_MAX_ITEMS_FREE));
    queries.logPlaylist.run(req.user.id, key, items);
  }
  res.json({ success: true, plan: access.plan, maxItems: access.maxItems });
});

// ─── POST /api/download/start ────────────────────────────────────
// Démarre un job de téléchargement en arrière-plan.
// Retourne immédiatement { jobId } — le frontend suit via SSE.
// Extrait en fonction nommée pour être réutilisée telle quelle par l'API
// externe Premium (/api/v1/download) sans dupliquer la logique.
const handleDownloadStart = async (req, res) => {
  const { url, quality = '1080p', format, title = 'video', sublang, trim, startTime, endTime } = req.body;

  if (!url) return res.status(400).json({ error: 'URL manquante' });
  // Validation + protection SSRF (rejette les cibles réseau internes).
  try { await assertPublicHttpUrl(url); }
  catch { return res.status(400).json({ error: 'URL invalide' }); }

  // Filet de sécurité DoS : la file d'attente elle-même est plafonnée.
  if (downloadQueue.length >= MAX_QUEUED_JOBS) {
    return res.status(503).json({
      error: 'Le serveur est actuellement très sollicité. Réessaie dans quelques instants.',
      code: 'SERVER_BUSY'
    });
  }

  const isPremiumUser = req.user?.plan === 'premium';
  const isAudio = quality === 'mp3' || quality === 'audio' || (format && format.includes('bestaudio') && !format.includes('bestvideo'));
  const clientKey = req.user?.id || `ip:${req.ip}`;
  let info = null; // Analyse de la vidéo, réutilisée pour estimer la taille du fichier.

  // Limite de durée pour les comptes gratuits (aucun plafond de ce type
  // n'existait : une vidéo de plusieurs heures en 1080p pouvait saturer
  // CPU/bande passante/disque sans qu'aucun garde-fou ne s'applique).
  if (!isPremiumUser) {
    try {
      info = await ytdlpInfo(url);
      if (info._type === 'playlist') {
        return res.status(400).json({
          error: 'Ce lien est une playlist. Analyse-le d\'abord pour choisir les vidéos à télécharger.',
          code: 'IS_PLAYLIST'
        });
      }
      if (info.duration && info.duration > FREE_MAX_DURATION_SEC) {
        const hours = (FREE_MAX_DURATION_SEC / 3600).toFixed(0);
        return res.status(403).json({
          error: `Vidéo trop longue pour un compte gratuit (max ${hours}h). Passe au plan Premium pour les vidéos illimitées.`,
          code: 'DURATION_LIMIT_REACHED'
        });
      }
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  // ── Découpage vidéo sur mesure : validation & quota d'essais gratuits ──
  let trimSections = null;
  let trimSeconds = null;
  if (trim === true || trim === 'true') {
    if (!TRIM_TIME_RE.test(startTime || '') || !TRIM_TIME_RE.test(endTime || '')) {
      return res.status(400).json({
        error: 'Format de temps invalide. Utilise MM:SS (ex : 00:10).',
        code: 'INVALID_TRIM_TIME'
      });
    }
    const startSec = parseTimeToSeconds(startTime);
    const endSec = parseTimeToSeconds(endTime);
    if (startSec === null || endSec === null || endSec <= startSec) {
      return res.status(400).json({
        error: 'L\'heure de fin doit être supérieure à l\'heure de début.',
        code: 'INVALID_TRIM_TIME'
      });
    }

    if (!req.user) {
      return res.status(403).json({
        error: 'Crée un compte gratuit pour utiliser le découpage vidéo sur mesure.',
        code: 'LOGIN_REQUIRED'
      });
    }

    if (!isPremiumUser) {
      if ((req.user.trim_trials_used || 0) >= FREE_TRIM_TRIAL_LIMIT) {
        return res.status(403).json({
          error: `Tu as utilisé tes ${FREE_TRIM_TRIAL_LIMIT} essais gratuits de découpage vidéo. Passe au plan Premium pour un découpage illimité.`,
          code: 'TRIM_LIMIT_REACHED'
        });
      }
      queries.incrementTrimTrial.run(req.user.id);
    }

    trimSections = `*${startTime}-${endTime}`;
    trimSeconds = endSec - startSec;
  }

  if (!isPremiumUser) {
    const dailyCount = queries.countDailyDownloads.get(clientKey).count;
    if (dailyCount >= FREE_DAILY_DOWNLOAD_LIMIT) {
      return res.status(429).json({
        error: `Limite gratuite atteinte : ${FREE_DAILY_DOWNLOAD_LIMIT} téléchargements par jour. Passe au plan Premium pour continuer.`,
        code: 'DAILY_LIMIT_REACHED'
      });
    }
  }

  // ── Sous-titres : validation de la langue & limite gratuite (5/jour) ──
  let normalizedSublang = null;
  if (sublang) {
    normalizedSublang = String(sublang).toLowerCase();
    if (!SUBTITLE_LANGS.includes(normalizedSublang)) {
      return res.status(400).json({
        error: 'Langue de sous-titres non supportée. Choisis parmi : ' + SUBTITLE_LANGS.join(', ') + '.',
        code: 'INVALID_SUBLANG'
      });
    }
    if (!isPremiumUser) {
      const subCount = queries.countDailySubtitleDownloads.get(clientKey).count;
      if (subCount >= FREE_SUBTITLE_DAILY_LIMIT) {
        return res.status(429).json({
          error: `Limite gratuite de sous-titres atteinte : ${FREE_SUBTITLE_DAILY_LIMIT} téléchargements avec sous-titres par jour. Passe au plan Premium pour des sous-titres illimités.`,
          code: 'SUBTITLE_LIMIT_REACHED'
        });
      }
    }
  }

  // 1. Vérification restriction 4K / 1440p pour les membres Premium
  const isReq4k = quality === '4k' || quality === '2160p' || quality === '1440p' || (format && (format.includes('2160') || format.includes('1440')));

  if (isReq4k && !isPremiumUser) {
    return res.status(403).json({
      error: '⚡ La qualité 4K Ultra HD est réservée aux abonnés Premium. Passe au plan Premium pour débloquer les téléchargements 4K et sans limite !',
      code: 'PREMIUM_REQUIRED'
    });
  }

  if (!isPremiumUser && format) {
    return res.status(403).json({
      error: 'Les formats personnalisés sont réservés aux abonnés Premium.',
      code: 'PREMIUM_REQUIRED'
    });
  }

  // Un sélecteur de format yt-dlp valide n'utilise qu'un jeu de caractères
  // restreint (id de format, opérateurs +/-/,/[]/<>=, espaces). Sans cette
  // validation, un compte Premium pourrait soumettre une chaîne pathologique
  // (très longue, énormément d'alternatives) pour faire consommer un temps de
  // résolution anormal à yt-dlp ou forcer des flux multiples inutiles.
  if (format && (format.length > 150 || !/^[\w+,\-\[\]<>=./: ]+$/.test(format))) {
    return res.status(400).json({ error: 'Format de téléchargement invalide.' });
  }

  // 2. Détermination du type (Audio vs Vidéo) et sélecteur de format exact
  const ext = isAudio ? 'mp3' : 'mp4';
  const safeTitle = (title || 'video').replace(/[^a-zA-Z0-9\s\-_àâäéèêëîïôöùûüç]/g, '').trim().slice(0, 80) || 'video';
  const jobId = uuid();
  const filepath = path.join(TMP_DIR, `${jobId}.${ext}`);
  const downloadLog = queries.logDownload.run(req.user?.id || null, clientKey, url, format || quality, safeTitle, normalizedSublang ? 1 : 0);

  // Créer le job en mémoire
  downloadJobs.set(jobId, {
    id: jobId,
    source: req.apiAuth ? 'api' : 'web',
    lastSeen: Date.now(),
    status: 'queued',
    queuePosition: null,
    running: false,
    estimatedBytes: null,
    percent: 0,
    speed: null,
    eta: null,
    total: null,
    filepath,
    title: safeTitle,
    ext,
    userId: req.user?.id || null,
    downloadLogId: downloadLog.lastInsertRowid,
    createdAt: Date.now(),
    error: null,
    _stderr: '',
  });

  // Sélection du format précis selon la résolution demandée
  const targetHeight = getTargetHeight(quality);
  downloadJobs.get(jobId).estimatedBytes = estimateDownloadBytes(info, { isAudio, targetHeight, trimSeconds });
  let formatSelector = getVideoFormatSelector(targetHeight);

  if (isAudio) {
    formatSelector = 'bestaudio/best';
    } else if (isPremiumUser && format) {
    formatSelector = format;
  }

  // 3. Arguments yt-dlp.
  //    Les sous-titres sont volontairement téléchargés SÉPARÉMENT (plus bas) pour
  //    qu'un échec de sous-titres (ex. HTTP 429) n'annule JAMAIS le téléchargement vidéo.
  const args = [
    '-f', formatSelector,
    '-o', filepath,
    '--newline',           // Une ligne par mise à jour de progression
    '--progress',
    '--no-warnings',
    '--no-playlist',
    // Filet de sécurité : si le lien est une playlist seule (--no-playlist n'y
    // change rien), on ne télécharge jamais plus que sa première vidéo.
    '--playlist-items', '1',
    '--no-mtime',
  ];

  if (isAudio) {
    args.push('--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0');
  } else {
    // Conteneur MP4 standard (H.264/AAC) lisible partout (iPhone, Android, PC).
    args.push('--merge-output-format', 'mp4');
  }

  // Découpage vidéo sur mesure : ne télécharge que la section demandée.
  // --force-keyframes-at-cuts force une coupe précise (au prix d'un léger réencodage
  // aux limites) plutôt qu'un arrondi au keyframe le plus proche.
  if (trimSections) {
    args.push('--download-sections', trimSections, '--force-keyframes-at-cuts');
  }

  // IMPORTANT : on n'impose AUCUN client YouTube spécifique (pas de
  // --extractor-args youtube:player_client=...). Le client par défaut de yt-dlp
  // expose la pleine gamme de résolutions (jusqu'à 4K), alors que le client
  // "android" plafonnait à 360p/720p et produisait des vidéos floues.
  args.push('--user-agent', YTDLP_UA);
  args.push(url);

  // Lancé par la file d'attente dès qu'une place se libère.
  const startJob = () => {
    let slotReleased = false;
    const finishJob = () => {
      if (slotReleased) return;
      slotReleased = true;
      releaseDownloadSlot(jobId);
    };

    const proc = spawn('yt-dlp', args);

    // Chien de garde : un job ne doit jamais rester bloqué indéfiniment.
    const watchdog = setTimeout(() => {
      const job = downloadJobs.get(jobId);
      if (job && job.status !== 'done' && job.status !== 'error') {
        job.status = 'error';
        job.error = 'Délai dépassé : le téléchargement a pris trop de temps. Réessaie.';
        try { proc.kill(); } catch { }
        sseEmit(jobId, { type: 'error', message: job.error });
        sseClose(jobId);
      }
    }, 15 * 60 * 1000);

    // ── Progression agrégée sur l'ensemble des flux ──────────────────
    // yt-dlp redémarre son compteur à 0 % pour chaque flux (vidéo puis audio).
    // On reconstitue une progression MONOTONE 0→99 % en tenant compte du nombre de
    // flux annoncé par yt-dlp, pour que la barre n'oscille plus de 100 % à 0 %.
    let expectedStreams = 1;
    let streamIndex = 0; // Nombre de flux dont le téléchargement a commencé
    let stdoutBuf = '';
    const streamBytes = []; // Taille annoncée par yt-dlp pour chaque flux

    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop(); // La dernière ligne peut être incomplète : on la garde
      for (const line of lines) {
        // « [info] ... Downloading 1 format(s): 137+140 » → yt-dlp compte 1 « format »
        // mais « 137+140 » correspond à 2 flux réels (vidéo + audio) : on compte les « + ».
        const info = line.match(/Downloading (\d+) format\(s?\)(?::\s*(\S+))?/i);
        if (info) {
          const spec = info[2] || '';
          const plusCount = (spec.match(/\+/g) || []).length;
          expectedStreams = Math.max(1, parseInt(info[1], 10), plusCount + 1);
          continue;
        }
        // « [download] Destination: ... » → un nouveau flux commence
        if (/\[download\]\s+Destination:/i.test(line)) {
          streamIndex += 1;
          expectedStreams = Math.max(expectedStreams, streamIndex);
          continue;
        }
        const progress = parseYtdlpProgress(line);
        if (progress) {
          const job = downloadJobs.get(jobId);
          if (!job) return;
          const streams = Math.max(expectedStreams, streamIndex, 1);
          const startedIndex = Math.max(streamIndex, 1); // 1-based
          const overall = Math.min(99, ((startedIndex - 1) + progress.percent / 100) / streams * 100);
          job.percent = Math.max(job.percent || 0, overall); // jamais décroissant
          job.speed = progress.speed;
          job.eta = progress.eta;
          job.total = progress.total;
          job.status = 'downloading';

          // La vraie taille remplace l'estimation : si le fichier s'avère
          // plus petit que prévu, la place libérée profite à la file d'attente.
          const announced = parseSizeToBytes(progress.total);
          if (announced) {
            streamBytes[startedIndex - 1] = announced;
            const weightBefore = jobWeight(job);
            job.estimatedBytes = streamBytes.reduce((sum, b) => sum + (b || 0), 0);
            if (jobWeight(job) < weightBefore) scheduleDownloads();
          }

          sseEmit(jobId, {
            type: 'progress',
            percent: job.percent,
            stream: startedIndex,
            streams,
            total: progress.total,
            speed: progress.speed,
            eta: progress.eta,
          });
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      const job = downloadJobs.get(jobId);
      if (job) job._stderr += chunk.toString();
    });

    const handleClose = async (code) => {
      clearTimeout(watchdog);
      const job = downloadJobs.get(jobId);
      if (!job) return;

      // Échec du téléchargement yt-dlp (réseau, vidéo indisponible, etc.)
      if (code !== 0 || !fs.existsSync(filepath)) {
        job.status = 'error';
        job.error = parseYtdlpError(job._stderr);
        try { queries.updateDownloadStatus.run('error', job.downloadLogId); } catch { }
        sseEmit(jobId, { type: 'error', message: job.error });
        sseClose(jobId);
        return;
      }

      // ── Finalisation : sous-titres (best-effort) + remux rapide ─────
      job.status = 'converting';
      job.percent = 99;
      sseEmit(jobId, {
        type: 'processing',
        percent: 99,
        message: normalizedSublang
          ? 'Récupération des sous-titres et finalisation…'
          : 'Finalisation et optimisation de la qualité…'
      });

      let subtitlePath = null;
      let subtitlesEmbedded = false;

      try {
        // Sous-titres en « best-effort » : récupérés dans un fichier séparé, puis
        // embarqués dans la même passe ffmpeg. Un échec ici (429, piste absente…)
        // n'empêche JAMAIS le téléchargement de la vidéo sans sous-titres.
        if (!isAudio && normalizedSublang) {
          subtitlePath = await downloadSubtitleFile(
            url, normalizedSublang, path.join(TMP_DIR, `${jobId}_sub`)
          );
          subtitlesEmbedded = Boolean(subtitlePath);
          if (!subtitlesEmbedded) {
            console.warn(`[download] ${jobId} : sous-titres '${normalizedSublang}' indisponibles — vidéo sans sous-titres.`);
          }
        }

        if (isAudio) {
          await transcodeAudio(filepath);
        } else {
          await finalizeVideo(filepath, targetHeight, subtitlePath, normalizedSublang || 'und');
        }
      } catch (error) {
        job.status = 'error';
        job.error = 'Conversion vidéo impossible : ' + error.message;
        try { queries.updateDownloadStatus.run('error', job.downloadLogId); } catch { }
        sseEmit(jobId, { type: 'error', message: job.error });
        sseClose(jobId);
        return;
      } finally {
        if (subtitlePath && fs.existsSync(subtitlePath)) {
          try { fs.unlinkSync(subtitlePath); } catch { }
        }
      }

      const verifiedVideo = isAudio ? null : await probeVideo(filepath);
      if (verifiedVideo && Number(verifiedVideo.height) > targetHeight) {
        job.status = 'error';
        job.error = `Résolution finale invalide : ${verifiedVideo.height}p demandé au maximum ${targetHeight}p.`;
        try { queries.updateDownloadStatus.run('error', job.downloadLogId); } catch { }
        sseEmit(jobId, { type: 'error', message: job.error });
        sseClose(jobId);
        return;
      }

      console.log(`[download] ${jobId} : requested=${isAudio ? 'audio' : `${targetHeight}p`} final=${isAudio ? 'audio' : `${verifiedVideo.width}x${verifiedVideo.height}`} codec=${isAudio ? 'mp3' : (verifiedVideo.codec_name || 'unknown')} subtitles=${isAudio ? 'n/a' : (subtitlesEmbedded ? normalizedSublang : 'none')}`);

      job.status = 'done';
      job.finishedAt = Date.now();
      job.percent = 100;
      const finalSize = fs.statSync(filepath).size;
      try { queries.updateDownloadStatus.run('done', job.downloadLogId); } catch { }
      sseEmit(jobId, {
        type: 'done',
        jobId,
        title: safeTitle,
        ext,
        finalSize,
        subtitles: subtitlesEmbedded,
        subtitleLang: subtitlesEmbedded ? normalizedSublang : null,
      });

      sseClose(jobId);
    };
    // La place n'est rendue qu'une fois le fichier entièrement prêt (ou en
    // erreur) : la conversion ffmpeg qui suit le téléchargement compte aussi.
    proc.on('close', (code) => {
      handleClose(code)
        .catch((err) => {
          console.error(`[download] ${jobId} : échec inattendu —`, err);
          const job = downloadJobs.get(jobId);
          if (job && job.status !== 'done') {
            job.status = 'error';
            job.error = 'Erreur interne pendant la finalisation. Réessaie.';
            try { queries.updateDownloadStatus.run('error', job.downloadLogId); } catch { }
            sseEmit(jobId, { type: 'error', message: job.error });
            sseClose(jobId);
          }
        })
        .finally(finishJob);
    });

    proc.on('error', (err) => {
      clearTimeout(watchdog);
      finishJob();
      const job = downloadJobs.get(jobId);
      if (job) {
        // Plus spécifique si yt-dlp n'est pas trouvé (ENOENT)
        if (err.code === 'ENOENT') {
          job.status = 'error';
          job.error = 'yt-dlp introuvable sur le serveur. Assure-toi qu\'il est installé et dans le PATH.';
        } else {
          job.status = 'error';
          job.error = 'Erreur interne lors du lancement de yt-dlp: ' + err.message;
        }
        sseEmit(jobId, { type: 'error', message: job.error });
        sseClose(jobId);
      }
    });
  };

  enqueueDownload(jobId, isPremiumUser, startJob);

  // Répondre immédiatement avec le jobId
  res.json({ success: true, jobId });
};
app.post('/api/download/start', downloadLimiter, optionalAuth, handleDownloadStart);

// ─── GET /api/progress/:jobId (Server-Sent Events) ───────────────
app.get('/api/progress/:jobId', optionalAuthHeaderOrQuery, (req, res) => {
  const job = downloadJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job introuvable' });
  // Un job démarré par un compte connecté n'est accessible qu'à ce compte
  // (le jobId, bien qu'un UUID difficile à deviner, peut fuiter via un
  // Referer, un proxy/CDN, ou un historique partagé). Les jobs anonymes
  // (job.userId === null) restent accessibles à quiconque connaît l'id, comme
  // avant, faute de meilleure notion de propriétaire.
  if (job.userId && (!req.user || req.user.id !== job.userId)) {
    return res.status(403).json({ error: 'Accès refusé' });
  }

  // Headers SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Désactiver le buffering Nginx
  res.flushHeaders();

  // Envoyer l'état actuel immédiatement
  if (job.status === 'done') {
    res.write(`data: ${JSON.stringify({ type: 'done', jobId: req.params.jobId, title: job.title, ext: job.ext })}\n\n`);
    return res.end();
  }
  if (job.status === 'error') {
    res.write(`data: ${JSON.stringify({ type: 'error', message: job.error })}\n\n`);
    return res.end();
  }
  job.lastSeen = Date.now();

  // Snapshot de l'état actuel
  if (job.status === 'queued') {
    res.write(`data: ${JSON.stringify({ type: 'queued', position: job.queuePosition })}\n\n`);
  } else {
    res.write(`data: ${JSON.stringify({
      type: 'progress', percent: job.percent, speed: job.speed, eta: job.eta, total: job.total
    })}\n\n`);
  }

  // Enregistrer ce client SSE
  if (!sseClients.has(req.params.jobId)) sseClients.set(req.params.jobId, []);
  sseClients.get(req.params.jobId).push(res);

  // Retour d'un visiteur qui avait été sauté : il peut démarrer s'il y a de la place.
  if (job.status === 'queued') scheduleDownloads();

  // Heartbeat toutes les 20s pour maintenir la connexion
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
  }, 20_000);

  // Nettoyage à la déconnexion du client
  req.on('close', () => {
    clearInterval(heartbeat);
    const clients = sseClients.get(req.params.jobId) || [];
    const idx = clients.indexOf(res);
    if (idx !== -1) clients.splice(idx, 1);
    job.lastSeen = Date.now(); // l'absence se compte à partir de la déconnexion
  });
});

// ─── GET /api/file/:jobId — Servir le fichier complété ───────────
// Ce token de job est à usage unique : le fichier est supprimé après livraison.
// Extrait en fonction nommée pour être réutilisée telle quelle par l'API
// externe Premium (/api/v1/download/:jobId/file) sans dupliquer la logique.
const handleFileDownload = (req, res) => {
  const job = downloadJobs.get(req.params.jobId);

  if (!job || job.status !== 'done')
    return res.status(404).json({ error: 'Fichier non disponible ou expiré' });

  if (job.userId && (!req.user || req.user.id !== job.userId)) {
    return res.status(403).json({ error: 'Accès refusé' });
  }

  if (!fs.existsSync(job.filepath))
    return res.status(404).json({ error: 'Fichier expiré. Relance le téléchargement.' });

  const mimeType = job.ext === 'mp3' ? 'audio/mpeg' : 'video/mp4';
  const encoded = encodeURIComponent(`${job.title}.${job.ext}`);

  res.setHeader('Content-Disposition', `attachment; filename="${job.title}.${job.ext}"; filename*=UTF-8''${encoded}`);
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', fs.statSync(job.filepath).size);

  const stream = fs.createReadStream(job.filepath);
  stream.pipe(res);

  // Supprimer le fichier temporaire après envoi complet
  const cleanup = () => {
    try {
      stream.destroy();
      if (fs.existsSync(job.filepath)) fs.unlinkSync(job.filepath);
      downloadJobs.delete(req.params.jobId);
    } catch { }
  };

  stream.on('end', cleanup);
  stream.on('error', cleanup);
  res.on('close', cleanup); // Si le client se déconnecte en cours de route
};
app.get('/api/file/:jobId', optionalAuthHeaderOrQuery, handleFileDownload);

// ─────────────────────────────────────────────────────────────────
//  API EXTERNE PREMIUM (/api/v1/*) — authentification par clé API
// ─────────────────────────────────────────────────────────────────
// Réutilise EXACTEMENT la même logique que les routes web internes
// (handleAnalyze, handleDownloadStart, handleFileDownload) : seule la couche
// d'authentification change (clé API au lieu du cookie/JWT du site), le
// comportement de téléchargement/analyse est identique et déjà testé.

app.get('/api/v1/analyze', apiKeyLimiter, verifyPremiumApiKey, handleAnalyze);
app.post('/api/v1/download', apiKeyLimiter, verifyPremiumApiKey, handleDownloadStart);
app.get('/api/v1/download/:jobId/file', apiKeyLimiter, verifyPremiumApiKey, handleFileDownload);

// Statut d'un job en JSON simple (plus adapté qu'un flux SSE pour un usage
// API/curl classique — le frontend web garde son suivi SSE existant, inchangé).
app.get('/api/v1/download/:jobId', apiKeyLimiter, verifyPremiumApiKey, (req, res) => {
  const job = downloadJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job introuvable' });
  if (job.userId && job.userId !== req.user.id) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  res.json({
    jobId: req.params.jobId,
    status: job.status,
    queuePosition: job.status === 'queued' ? job.queuePosition : undefined,
    percent: job.percent,
    speed: job.speed,
    eta: job.eta,
    total: job.total,
    error: job.error,
    title: job.status === 'done' ? job.title : undefined,
    ext: job.status === 'done' ? job.ext : undefined,
  });
});

// ─────────────────────────────────────────────────────────────────
//  ROUTES PAIEMENT (GeniusPay)
// ─────────────────────────────────────────────────────────────────

app.post('/api/payment/initiate', authMiddleware, downloadLimiter, async (req, res) => {
  const { provider = 'geniuspay', currency = 'XAF', plan = 'monthly' } = req.body;
  if (provider !== 'geniuspay')
    return res.status(400).json({ error: 'Prestataire de paiement non supporté' });

  const normalizedCurrency = String(currency).toUpperCase();
  const amount = getPlanAmount(plan, normalizedCurrency);
  if (amount === null)
    return res.status(400).json({ error: 'Forfait ou monnaie non supporté' });

  // Le compte marchand GeniusPay (ivoirien) ne facture qu'en XOF — envoyer
  // XAF ou toute autre devise fait échouer l'appel (erreur "validation.in"
  // constatée en test réel le 20/09/2026, alors que XOF est accepté).
  // On convertit donc vers l'équivalent XOF via la même table de taux (XAF et
  // XOF ont exactement la même valeur dans CURRENCY_RATES, donc aucun
  // changement pour les utilisateurs camerounais) et c'est CE montant qu'on
  // enregistre, puisque c'est celui que GeniusPay renverra dans le webhook.
  const billedAmount = normalizedCurrency === 'XOF'
    ? amount
    : Math.round(amount / CURRENCY_RATES[normalizedCurrency] * CURRENCY_RATES.XOF);

  const txId = 'SL-' + uuid().replace(/-/g, '').slice(0, 16).toUpperCase();
  queries.createTransaction.run(txId, req.user.id, provider, billedAmount, plan);

  try {
    const payment_url = await initGeniusPay(txId, req.user, billedAmount, 'XOF');
    res.json({ success: true, payment_url, transaction_id: txId, currency: normalizedCurrency, amount, plan });
  } catch (e) {
    console.error('[GENIUSPAY PAYMENT]', e.message);
    res.status(e.message.startsWith('Paiement indisponible') ? 503 : 500).json({ error: e.message });
  }
});

// ─── Prestataire de paiement GeniusPay ────────────────────────────
// Contrat vérifié contre le plugin officiel WooCommerce de GeniusPay
// (geniuspay-woocommerce, includes/class-geniuspay-api.php + class-geniuspay-gateway.php)
// puis confirmé via le dashboard réel du compte : l'ancienne URL
// `api.geniuspay.com` était un domaine fictif (échec TLS "unrecognized_name"
// déjà constaté en test) — le vrai endpoint (point d'entrée API du dashboard)
// est `https://geniuspay.ci/api/v1/merchant`.

async function initGeniusPay(txId, user, amount = PRICE_FCFA, currency = 'XOF') {
  const apiKey = process.env.GENIUSPAY_API_KEY;
  const apiSecret = process.env.GENIUSPAY_API_SECRET;

  // Si l'API GeniusPay est configurée dans .env
  if (apiKey) {
    try {
      const response = await axios.post(
        (process.env.GENIUSPAY_API_URL || 'https://geniuspay.ci/api/v1/merchant') + '/payments',
        {
          amount: Number(amount),
          currency: String(currency).toUpperCase(),
          description: 'StreamLoader Premium — Abonnement sélectionné',
          customer: {
            name: user.email.split('@')[0],
            email: user.email,
          },
          success_url: `${APP_URL}/payment/success?tx=${txId}`,
          error_url: `${APP_URL}/payment/cancel?tx=${txId}`,
          // metadata.order_id est renvoyé tel quel dans le webhook — c'est ce
          // qui permet de relier l'événement à cette transaction (GeniusPay
          // génère sa PROPRE référence, distincte de notre txId interne).
          metadata: {
            order_id: txId,
            site_url: APP_URL,
          },
        },
        {
          headers: {
            'X-API-Key': apiKey,
            'X-API-Secret': apiSecret || '',
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          timeout: 10_000
        }
      );
      const data = response.data?.data || {};
      const redirectUrl = data.checkout_url || data.payment_url;
      if (!redirectUrl) {
        console.warn('[GeniusPay API Call] Réponse sans checkout_url/payment_url:', response.data);
        throw new Error('Réponse GeniusPay invalide.');
      }
      return redirectUrl;
    } catch (err) {
      // Détail complet loggé côté serveur uniquement — jamais renvoyé au
      // client (évite de divulguer des détails internes de l'API GeniusPay).
      console.warn('[GeniusPay API Call]', err.response?.data || err.message);
      throw new Error('Paiement momentanément indisponible, réessaie plus tard.');
    }
  }

  throw new Error('Paiement indisponible : les clés GeniusPay ne sont pas configurées.');
}

// ─── Activation Premium ───────────────────────────────────────────

function activatePremium(txId, reportedAmount) {
  try {
    const tx = queries.getTransaction.get(txId);
    if (!tx || tx.status === 'completed') return;

    // Défense en profondeur : si le webhook indique un montant, il doit
    // correspondre à celui enregistré côté serveur lors de l'initiation du
    // paiement (queries.createTransaction). Sans ce contrôle, un webhook
    // renvoyant un montant partiel ou falsifié activerait Premium sans
    // paiement complet.
    if (reportedAmount != null && Number(reportedAmount) !== Number(tx.amount)) {
      console.error(`[PREMIUM] Montant webhook (${reportedAmount}) ≠ montant attendu (${tx.amount}) pour tx:${txId} — activation refusée.`);
      return;
    }

    queries.completeTransaction.run(txId);
    const months = SUBSCRIPTION_PLANS[tx.plan]?.months || 1;
    queries.upgradeToPremium.run(months, tx.user_id);
    console.log(`[PREMIUM] Activé — user:${tx.user_id} tx:${txId}`);
  } catch (e) {
    console.error('[activatePremium]', e.message);
  }
}

// ─── Webhook GeniusPay ────────────────────────────────────────────

function isValidGeniusPaySignature(req) {
  const signature = (req.get('x-geniuspay-signature') || '').replace(/^sha256=/i, '').trim();
  if (!GENIUSPAY_WEBHOOK_SECRET || !signature || !req.rawBody) return false;
  const expected = crypto.createHmac('sha256', GENIUSPAY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('hex');
  const receivedBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return receivedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

// Format réel du webhook GeniusPay (vérifié contre le plugin officiel
// WooCommerce) : { event: "payment.completed", data: { reference,
// gateway_reference, fees, net_amount, metadata: { order_id, ... }, ... } }
// — PAS un champ "status" à plat comme le code le supposait avant. La
// correspondance avec notre transaction se fait via metadata.order_id (notre
// txId, renvoyé tel quel par GeniusPay), pas via "reference" (qui est
// l'identifiant généré CÔTÉ GENIUSPAY, différent du nôtre).
app.post('/api/payment/webhook/geniuspay', async (req, res) => {
  if (!isValidGeniusPaySignature(req))
    return res.status(401).json({ error: 'Signature webhook invalide' });

  const event = req.body?.event;
  const data = req.body?.data || {};
  const targetId = data?.metadata?.order_id || data?.reference;
  const isCompleted = event === 'payment.completed' || event === 'transaction.completed';

  try {
    if (isCompleted && targetId) {
      // data.amount n'est pas documenté par GeniusPay pour cet événement
      // (seuls "fees"/"net_amount" le sont) — la vérification de montant dans
      // activatePremium() s'auto-désactive proprement si ce champ est absent.
      activatePremium(targetId, data.amount);
    }
  } catch (e) {
    console.error('[GeniusPay Webhook]', e.message);
  }
  res.json({ received: true });
});

app.get('/api/payment/status/:txId', authMiddleware, (req, res) => {
  const tx = queries.getTransaction.get(req.params.txId);
  if (!tx || tx.user_id !== req.user.id)
    return res.status(404).json({ error: 'Transaction introuvable' });
  res.json({ status: tx.status, is_premium: tx.status === 'completed' });
});

// ─── Pages retour paiement ────────────────────────────────────────

// Mêmes couleurs et polices que le site (voir les tokens de public/index.html).
const PAY_ICONS = {
  success: '<path d="m7 12.5 3.2 3.2L17 9"/>',
  cancel: '<path d="m8.5 8.5 7 7M15.5 8.5l-7 7"/>',
};
const payPage = (kind, title, msg, redirect) =>
  `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — StreamLoader</title>
  <meta http-equiv="refresh" content="3;url=${redirect}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..700&family=Instrument+Sans:wght@400..700&display=swap" rel="stylesheet">
  <style>
  :root{--bg:#F6F5F1;--text:#17171A;--dim:#4B4A52;--line:#CFCBC1;--ok:#1E7F49;--ko:#C42B3A}
  @media (prefers-color-scheme:dark){:root{--bg:#212125;--text:#F1F0EC;--dim:#C4C2C9;--line:#4A4A53;--ok:#52C487;--ko:#F2646F}}
  *{box-sizing:border-box;margin:0}
  body{font-family:'Instrument Sans',system-ui,sans-serif;background:var(--bg);color:var(--text);
  display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;text-align:center;-webkit-font-smoothing:antialiased}
  .b{max-width:420px}
  .i{width:52px;height:52px;margin:0 auto 22px;border:1.5px solid var(--line);border-radius:50%;display:flex;align-items:center;justify-content:center}
  .i svg{width:24px;height:24px;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
  .success svg{stroke:var(--ok)} .cancel svg{stroke:var(--ko)}
  h1{font-family:'Bricolage Grotesque',sans-serif;font-size:28px;font-weight:650;letter-spacing:-.02em;margin-bottom:8px}
  p{color:var(--dim);font-size:15px;line-height:1.6}
  a{color:var(--text);text-underline-offset:2px}
  </style>
  </head><body>
  <div class="b"><div class="i ${kind}"><svg viewBox="0 0 24 24">${PAY_ICONS[kind]}</svg></div>
  <h1>${title}</h1><p>${msg}<br><a href="${redirect}">Retourner au site</a></p></div>
  </body></html>`;

app.get('/payment/success', (_, res) =>
  res.send(payPage('success', 'Paiement réussi', 'Ton compte Premium est activé. Retour au site dans quelques secondes…', '/?premium=success')));
app.get('/payment/cancel', (_, res) =>
  res.send(payPage('cancel', 'Paiement annulé', 'Aucun montant n’a été débité. Retour au site dans quelques secondes…', '/')));

// ─────────────────────────────────────────────────────────────────
//  HEALTH CHECK
// ─────────────────────────────────────────────────────────────────

// Réponse volontairement minimale : cette route est publique et non
// authentifiée (utilisée par les health checks Railway/uptime monitors).
// Les détails internes (version yt-dlp, jobs actifs, clients SSE, config
// paiement) ne sont plus exposés à n'importe qui — consulter les logs serveur
// pour ces informations.
app.get('/api/health', (_, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/ads/banners', (_, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // showEmpty : hors production, les emplacements sans publicité s'affichent
  // comme des cadres vides pour visualiser leur position et leur taille. En
  // production, un emplacement vide reste caché (pas de cadre vide aux visiteurs).
  res.json({ ...AD_BANNERS, showEmpty: !IS_PROD });
});

app.get('/api/ad-click', (_, res) => {
  if (AD_REDIRECT_URL) return res.redirect(302, AD_REDIRECT_URL);
  res.redirect(302, '/#pricing');
});

// ─── Avis (reviews) ───────────────────────────────────────────────
// Ouverts sans compte, mais modérés : un avis soumis passe en statut
// 'pending' et n'apparaît nulle part publiquement tant qu'un admin ne l'a
// pas approuvé via /admin-reviews.html.

app.post('/api/reviews', reviewLimiter, (req, res) => {
  const { rating, comment } = req.body;
  const ratingNum = Number(rating);
  if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ error: 'Note invalide (1 à 5 étoiles).' });
  }
  const cleanComment = typeof comment === 'string' ? comment.trim().slice(0, 500) : null;
  const clientKey = `ip:${req.ip}`;

  // Filet supplémentaire au-delà du rate limiter (survit à un redémarrage du
  // serveur, contrairement au compteur en mémoire d'express-rate-limit).
  if (queries.countPendingReviewsToday.get(clientKey).count >= 5) {
    return res.status(429).json({ error: 'Trop d\'avis envoyés depuis cette adresse aujourd\'hui.' });
  }

  queries.createReview.run(clientKey, ratingNum, cleanComment);
  res.status(201).json({ success: true, message: 'Merci ! Ton avis sera visible après validation.' });
});

// Stats publiques (note moyenne + nombre d'avis) — uniquement les avis
// approuvés. Utilisé pour afficher une note réelle sur la page d'accueil.
app.get('/api/reviews/stats', (_, res) => {
  const { count, average } = queries.getReviewStats.get();
  res.json({
    count: count || 0,
    average: count > 0 ? Math.round(average * 10) / 10 : null,
  });
});

// Avis approuvés récents, pour affichage en témoignages.
app.get('/api/reviews', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
  const reviews = queries.listApprovedReviews.all(limit);
  res.json({ reviews });
});

// ─── Modération des avis (admin) ──────────────────────────────────

app.get('/api/admin/reviews/pending', requireAdminToken, (_, res) => {
  res.json({ reviews: queries.listPendingReviews.all() });
});

app.post('/api/admin/reviews/:id/approve', requireAdminToken, (req, res) => {
  queries.approveReview.run(req.params.id);
  res.json({ success: true });
});

app.post('/api/admin/reviews/:id/reject', requireAdminToken, (req, res) => {
  queries.rejectReview.run(req.params.id);
  res.json({ success: true });
});

// ─── SPA Fallback ─────────────────────────────────────────────────

app.get('*', (_, res) => res.sendFile(FRONTEND_FILE));

// ─────────────────────────────────────────────────────────────────
//  GESTION D'ERREURS GLOBALE
// ─────────────────────────────────────────────────────────────────

app.use((err, req, res, next) => {
  console.error('[UNHANDLED]', err.stack || err.message);
  res.status(500).json({ error: 'Erreur serveur interne' });
});

// ─────────────────────────────────────────────────────────────────
//  DÉMARRAGE DU SERVEUR
// ─────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  StreamLoader v2.1 — ${IS_PROD ? 'PRODUCTION' : 'DÉVELOPPEMENT'}                         ║
║  http://localhost:${PORT}                                      ║
╠══════════════════════════════════════════════════════════════╣
║  ✅ Rate limiting      (global + analyze + download + auth)  ║
║  ✅ SSE progression    (/api/progress/:jobId)                ║
║  ✅ Tokens de fichier  (/api/file/:jobId — usage unique)     ║
║  ✅ CORS               (${IS_PROD ? 'strict : ' + APP_URL : 'dev : *'})    ║
║  ✅ yt-dlp auto-update (24h)                                 ║
║  ✅ Graceful shutdown  (SIGINT / SIGTERM)                     ║
╚══════════════════════════════════════════════════════════════╝
  `);
});

// ─────────────────────────────────────────────────────────────────
//  ARRÊT PROPRE — SIGINT / SIGTERM
// ─────────────────────────────────────────────────────────────────

function gracefulShutdown(signal) {
  console.log(`\n[${signal}] Arrêt propre en cours...`);

  // 1. Fermer tous les clients SSE
  for (const clients of sseClients.values()) {
    for (const c of clients) { try { c.end(); } catch { } }
  }

  // 2. Stopper les timers
  clearInterval(ytdlpUpdateTimer);
  clearInterval(jobCleanupTimer);

  // 3. Supprimer les fichiers temporaires en cours
  for (const job of downloadJobs.values()) {
    if (job.filepath && fs.existsSync(job.filepath)) {
      try { fs.unlinkSync(job.filepath); } catch { }
    }
  }

  // 4. Fermer SQLite proprement
  try { db.close(); console.log('[DB] SQLite fermé.'); }
  catch (e) { console.error('[DB] Erreur fermeture :', e.message); }

  // 5. Fermer le serveur HTTP
  server.close(() => {
    console.log('[SERVER] Arrêt propre terminé.');
    process.exit(0);
  });

  // Forcer l'exit après 8s si quelque chose est bloqué
  setTimeout(() => {
    console.error('[SERVER] Timeout — arrêt forcé.');
    process.exit(1);
  }, 8_000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err.stack);
  // Erreur fatale de démarrage (port déjà utilisé) : on quitte immédiatement
  // au lieu de rester en « zombie » qui bloque le port sans rien servir.
  if (err && err.code === 'EADDRINUSE') process.exit(1);
  // Pour le reste, ne pas crasher en prod sur une erreur non fatale.
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

module.exports = { app, server };
