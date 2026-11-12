// ─────────────────────────────────────────────────────────────────
//  StreamLoader Desktop — processus principal (Electron)
//
//  L'application ne télécharge rien elle-même avec yt-dlp : elle pilote
//  le serveur StreamLoader (mêmes routes que le site) et enregistre le
//  fichier final sur le PC. L'accès est réservé aux comptes Premium :
//  le plan est vérifié par le serveur (/api/auth/me) à l'ouverture puis
//  régulièrement, et chaque téléchargement repasse par le serveur qui
//  applique lui-même ses règles Premium.
// ─────────────────────────────────────────────────────────────────

const {
  app, BrowserWindow, ipcMain, dialog, shell, safeStorage,
  clipboard, nativeTheme, Notification, nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { once } = require('events');

const IS_DEV = process.argv.includes('--dev');
const APP_ID = 'app.streamloader.desktop';
const CONFIG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); }
  catch { return {}; }
})();
const DEFAULT_SERVER = CONFIG.serverUrl || 'https://back.streamloaders.net';
// Routes de l'API (celles du serveur en ligne back.streamloaders.net)
const ROUTES = {
  analyze: '/api/media/analyze',
  downloadStart: '/api/media/download/start',
  progress: '/api/media/progress/',
  file: '/api/media/file/',
  playlistStart: '/api/playlist/start',
  ...(CONFIG.routes || {}),
};
const SITE_URL = CONFIG.siteUrl || 'https://streamloaders.net';
const PREMIUM_PATH = CONFIG.premiumPath || '/#pricing';
// « server » : version clients Premium (téléchargements par le serveur).
// « local »  : version personnelle (yt-dlp + ffmpeg sur ce PC, sans compte ni limite).
const MODE = CONFIG.mode === 'local' ? 'local' : 'server';
const IS_LOCAL = MODE === 'local';
const local = IS_LOCAL ? require('./local') : null;

const SESSION_REFRESH_MS = 20 * 60 * 1000; // revérifie le plan toutes les 20 min
const HISTORY_LIMIT = 500;
const QUALITIES = ['mp3', '360p', '480p', '720p', '1080p', '1440p', '4k'];

// Sites dont un lien copié déclenche le téléchargement automatique.
const AUTO_HOSTS = /(^|\.)(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|fb\.watch|x\.com|twitter\.com|vimeo\.com|dailymotion\.com|dai\.ly|twitch\.tv|soundcloud\.com|reddit\.com|pinterest\.[a-z.]+|pin\.it|snapchat\.com|bilibili\.com|linkedin\.com|threads\.net)$/i;

// Chaque version a son propre dossier de données (historique, réglages, photo, session)
if (IS_LOCAL) app.setPath('userData', path.join(app.getPath('appData'), 'StreamLoader Local'));
app.setAppUserModelId(IS_LOCAL ? 'app.streamloader.local' : APP_ID);
if (!app.requestSingleInstanceLock()) { app.quit(); }

// ─── Fichiers locaux ─────────────────────────────────────────────
const userDir = () => app.getPath('userData');
const SETTINGS_FILE = () => path.join(userDir(), 'settings.json');
const HISTORY_FILE = () => path.join(userDir(), 'history.json');
const SESSION_FILE = () => path.join(userDir(), 'session.bin');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ─── Réglages ────────────────────────────────────────────────────
let settings;
function defaultSettings() {
  const locale = (app.getLocale() || 'fr').toLowerCase();
  return {
    serverUrl: DEFAULT_SERVER,
    downloadDir: path.join(app.getPath('downloads'), 'StreamLoader'),
    defaultFormat: '1080p',
    autoDownload: false,
    maxConcurrent: 2,
    language: locale.startsWith('fr') ? 'fr' : 'en',
    theme: 'system',
    notifications: true,
    cookiesBrowser: 'none',
  };
}
function loadSettings() {
  const saved = readJson(SETTINGS_FILE(), {});
  // Adresse de serveur : seule une adresse personnalisée est conservée ;
  // sinon on suit celle de config.json (utile quand le domaine change).
  if (!saved.serverUrlCustom) delete saved.serverUrl;
  settings = { ...defaultSettings(), ...saved };
  if (!QUALITIES.includes(settings.defaultFormat)) settings.defaultFormat = '1080p';
  nativeTheme.themeSource = ['light', 'dark'].includes(settings.theme) ? settings.theme : 'system';
}
function saveSettings() { writeJsonAtomic(SETTINGS_FILE(), settings); }

function updateSettings(patch = {}) {
  const next = { ...settings };
  if (typeof patch.downloadDir === 'string' && patch.downloadDir.trim()) next.downloadDir = patch.downloadDir;
  if (QUALITIES.includes(patch.defaultFormat)) next.defaultFormat = patch.defaultFormat;
  if (typeof patch.autoDownload === 'boolean') next.autoDownload = patch.autoDownload;
  if ([1, 2, 3, 4].includes(Number(patch.maxConcurrent))) next.maxConcurrent = Number(patch.maxConcurrent);
  if (['fr', 'en'].includes(patch.language)) next.language = patch.language;
  if (['light', 'dark', 'system'].includes(patch.theme)) next.theme = patch.theme;
  if (typeof patch.notifications === 'boolean') next.notifications = patch.notifications;
  if (['none', 'firefox', 'edge', 'chrome', 'brave', 'opera', 'vivaldi'].includes(patch.cookiesBrowser)) next.cookiesBrowser = patch.cookiesBrowser;
  if (typeof patch.serverUrl === 'string') {
    const raw = patch.serverUrl.trim().replace(/\/+$/, '');
    if (!raw) { next.serverUrl = DEFAULT_SERVER; next.serverUrlCustom = false; }
    else {
      try {
        const u = new URL(raw);
        if (!/^https?:$/.test(u.protocol)) throw new Error();
        next.serverUrl = u.origin;
        next.serverUrlCustom = u.origin !== DEFAULT_SERVER;
      } catch { throw new Error('INVALID_SERVER_URL'); }
    }
  }
  settings = next;
  if (IS_LOCAL) local.setCookiesBrowser(settings.cookiesBrowser);
  nativeTheme.themeSource = ['light', 'dark'].includes(settings.theme) ? settings.theme : 'system';
  saveSettings();
  startClipboardWatch();
  pump();
  broadcast('settings:changed', settings);
  return settings;
}

// ─── Session (jeton chiffré par Windows via safeStorage) ─────────
let session = { token: null, user: null, checkedAt: 0 };

function loadSession() {
  try {
    const buf = fs.readFileSync(SESSION_FILE());
    const raw = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
    session = { checkedAt: 0, ...JSON.parse(raw) };
  } catch { session = { token: null, user: null, checkedAt: 0 }; }
}
function saveSession() {
  const raw = JSON.stringify(session);
  const buf = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(raw) : Buffer.from(raw, 'utf8');
  fs.writeFileSync(SESSION_FILE(), buf);
}
function clearSession() {
  session = { token: null, user: null, checkedAt: 0 };
  try { fs.unlinkSync(SESSION_FILE()); } catch { }
}

// Les dates SQLite du serveur sont en UTC au format « AAAA-MM-JJ HH:MM:SS ».
function parseServerDate(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? null : d;
}
function isPremium(user) {
  if (!user || user.plan !== 'premium') return false;
  const until = parseServerDate(user.premium_until);
  return !until || until.getTime() > Date.now();
}
function canDownload() { return IS_LOCAL || isPremium(session.user); }

function publicSession() {
  if (IS_LOCAL) {
    return { loggedIn: true, isPremium: true, local: true, email: settings?.profileName || 'Moi', plan: 'local', premiumUntil: null, offline: false };
  }
  const u = session.user;
  return {
    loggedIn: Boolean(session.token && u),
    email: u?.email || null,
    plan: u?.plan || null,
    premiumUntil: parseServerDate(u?.premium_until)?.toISOString() || null,
    isPremium: isPremium(u),
    offline: Boolean(session.offline),
  };
}

// ─── Appels au serveur StreamLoader ──────────────────────────────
class ApiError extends Error {
  constructor(message, { status = 0, code = null } = {}) {
    super(message); this.status = status; this.code = code;
  }
}

async function api(pathname, { method = 'GET', body, auth = true, signal, raw = false } = {}) {
  const url = new URL(pathname, settings.serverUrl + '/');
  const headers = {
    Accept: raw ? '*/*' : 'application/json',
    'User-Agent': `StreamLoaderDesktop/${app.getVersion()} (Windows)`,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && session.token) headers.Authorization = `Bearer ${session.token}`;

  let res;
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError('NETWORK', { status: 0, code: 'NETWORK' });
  }
  if (raw && res.ok) return res;

  let data = {};
  try { data = await res.json(); } catch { }
  if (!res.ok) {
    if (res.status === 401 && auth && session.token) handleUnauthorized();
    throw new ApiError(data.error || `HTTP ${res.status}`, { status: res.status, code: data.code || null });
  }
  return data;
}

function handleUnauthorized() {
  clearSession();
  cancelAll();
  broadcast('session:changed', publicSession());
}

async function login(email, password) {
  if (IS_LOCAL) return publicSession();
  const data = await api('/api/auth/login', {
    method: 'POST', auth: false,
    body: { email: String(email || '').trim(), password: String(password || '') },
  });
  session = { token: data.token, user: data.user, checkedAt: Date.now() };
  // /api/auth/me renvoie aussi la date de fin du Premium
  try { const me = await api('/api/auth/me'); session.user = me.user; } catch { }
  saveSession();
  broadcast('session:changed', publicSession());
  startClipboardWatch();
  return publicSession();
}

function logout() {
  if (IS_LOCAL) return publicSession();
  cancelAll();
  clearSession();
  broadcast('session:changed', publicSession());
  return publicSession();
}

async function refreshSession() {
  if (IS_LOCAL || !session.token) return publicSession();
  try {
    const me = await api('/api/auth/me');
    const wasPremium = isPremium(session.user);
    session.user = me.user;
    session.checkedAt = Date.now();
    session.offline = false;
    saveSession();
    if (wasPremium && !isPremium(session.user)) cancelAll();
  } catch (e) {
    // Hors ligne : on garde le dernier état connu (le serveur refusera de toute façon
    // les fonctions Premium si l'abonnement a expiré entre-temps).
    if (e.code === 'NETWORK') session.offline = true;
  }
  broadcast('session:changed', publicSession());
  return publicSession();
}

function requirePremium() {
  if (IS_LOCAL) return;
  if (!session.token) throw new ApiError('LOGIN_REQUIRED', { code: 'LOGIN_REQUIRED' });
  if (!isPremium(session.user)) throw new ApiError('PREMIUM_REQUIRED', { code: 'PREMIUM_REQUIRED' });
}

// ─── Historique & file de téléchargement ─────────────────────────
let items = [];
const active = new Map(); // id → AbortController
let saveTimer = null;
let pushTimer = null;

function loadHistory() {
  items = readJson(HISTORY_FILE(), []);
  if (!Array.isArray(items)) items = [];
  // Ce qui tournait à la fermeture est marqué interrompu (réessayable).
  for (const it of items) {
    if (!['done', 'error', 'canceled'].includes(it.status)) {
      it.status = 'error'; it.error = 'INTERRUPTED'; it.percent = 0;
    }
  }
}
function persistSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { writeJsonAtomic(HISTORY_FILE(), items.slice(0, HISTORY_LIMIT)); } catch { }
  }, 400);
}
function pushSoon() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => { pushTimer = null; broadcast('downloads:changed', items); }, 120);
}
function changed() { persistSoon(); pushSoon(); }
function findItem(id) { return items.find((i) => i.id === id); }

function newItem(url, quality, extra = {}) {
  const it = {
    id: crypto.randomUUID(),
    url, quality,
    ext: quality === 'mp3' ? 'mp3' : 'mp4',
    title: null, thumbnail: null, uploader: null, duration: null,
    status: 'analyzing', percent: 0, speed: null, eta: null,
    queuePosition: null, sizeBytes: null, filePath: null, error: null,
    createdAt: Date.now(), finishedAt: null,
    ...extra,
  };
  items.unshift(it);
  if (items.length > HISTORY_LIMIT) items.length = HISTORY_LIMIT;
  changed();
  return it;
}

function normalizeUrl(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return null;
    return u.toString();
  } catch { return null; }
}

const SUB_LANGS = ['fr', 'en', 'es', 'it', 'de', 'ar'];
const TRIM_RE = /^\d{1,2}(:\d{2}){1,2}$/;

// Analyse d'un lien (vidéo ou playlist) — affichée dans la fiche avant le téléchargement.
async function analyzeLink(input) {
  requirePremium();
  const url = normalizeUrl(input);
  if (!url) throw new ApiError('INVALID_URL', { code: 'INVALID_URL' });
  const res = IS_LOCAL ? await local.analyze(url) : await api(`${ROUTES.analyze}?url=${encodeURIComponent(url)}`);
  if (res.playlist) return { kind: 'playlist', url, playlist: res.playlist };
  const d = res.data;
  // Hauteurs vidéo réellement disponibles : seules ces qualités sont proposées.
  const heights = [...new Set((d.formats || []).filter((f) => f.vcodec && f.height).map((f) => f.height))].sort((a, b) => b - a);
  return { kind: 'video', url: d.webpage || url, data: { ...d, heights } };
}

function cleanOptions(o = {}) {
  const quality = QUALITIES.includes(o.quality) ? o.quality : settings.defaultFormat;
  const sublang = quality !== 'mp3' && SUB_LANGS.includes(o.sublang) ? o.sublang : null;
  let trim = null;
  if (o.trim && TRIM_RE.test(o.trim.start || '') && TRIM_RE.test(o.trim.end || '')) {
    trim = { start: o.trim.start, end: o.trim.end };
  } else if (o.trim) {
    throw new ApiError('INVALID_TRIM_TIME', { code: 'INVALID_TRIM_TIME' });
  }
  return { quality, sublang, trim };
}

// Ajoute une vidéo déjà analysée, avec les options choisies dans la fiche.
function enqueueVideo(p = {}) {
  requirePremium();
  const url = normalizeUrl(p.url);
  if (!url) throw new ApiError('INVALID_URL', { code: 'INVALID_URL' });
  const opts = cleanOptions(p);
  const it = newItem(url, opts.quality, {
    title: p.title || null, thumbnail: p.thumbnail || null, uploader: p.uploader || null,
    duration: p.duration || null, sublang: opts.sublang, trim: opts.trim, status: 'waiting',
  });
  pump();
  return { id: it.id };
}

// Ajoute les vidéos cochées d'une playlist (quota vérifié par le serveur).
async function enqueuePlaylist(p = {}) {
  requirePremium();
  const entries = (Array.isArray(p.entries) ? p.entries : []).filter((e) => normalizeUrl(e.url));
  if (!entries.length) throw new ApiError('EMPTY_SELECTION', { code: 'EMPTY_SELECTION' });
  const opts = cleanOptions({ quality: p.quality, sublang: p.sublang });
  // Quota hebdomadaire des comptes gratuits ; un Premium n'en a pas. Si le serveur
  // n'a pas cette route (404), on continue simplement.
  if (!IS_LOCAL) try { await api(ROUTES.playlistStart, { method: 'POST', body: { url: p.webpage, count: entries.length } }); }
  catch (e) { if (e.status !== 404) throw e; }
  for (const e of [...entries].reverse()) {
    newItem(normalizeUrl(e.url), opts.quality, {
      title: e.title || null, duration: e.duration || null, uploader: p.uploader || null,
      sublang: opts.sublang, status: 'waiting', playlist: p.title || null,
    });
  }
  pump();
  return { count: entries.length, title: p.title };
}

// Téléchargement direct (mode automatique du presse-papiers) : format par défaut, sans fiche.
async function addDownload(input, quality) {
  const a = await analyzeLink(input);
  if (a.kind === 'playlist') {
    return enqueuePlaylist({ ...a.playlist, webpage: a.playlist.webpage || a.url, quality });
  }
  const best = a.data.heights[0] || 0;
  let q = QUALITIES.includes(quality) ? quality : settings.defaultFormat;
  // Ne pas demander plus que ce que la vidéo propose
  const H = { '360p': 360, '480p': 480, '720p': 720, '1080p': 1080, '1440p': 1440, '4k': 2160 };
  if (q !== 'mp3' && best && H[q] > best) q = Object.keys(H).reverse().find((k) => H[k] <= best) || '360p';
  return enqueueVideo({ url: a.url, quality: q, title: a.data.title, thumbnail: a.data.thumbnail, uploader: a.data.uploader, duration: a.data.duration });
}

function pump() {
  if (!canDownload()) return;
  const running = items.filter((i) => active.has(i.id)).length;
  let free = Math.max(0, settings.maxConcurrent - running);
  // Les plus anciens d'abord
  const waiting = items.filter((i) => i.status === 'waiting' && !active.has(i.id)).reverse();
  for (const it of waiting) {
    if (free-- <= 0) break;
    runDownload(it);
  }
}

// Lit le flux SSE du serveur jusqu'à « done » ou « error ».
async function followProgress(it, jobId, signal) {
  const res = await api(`${ROUTES.progress}${encodeURIComponent(jobId)}`, { raw: true, signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (!data) continue;
      let msg; try { msg = JSON.parse(data); } catch { continue; }
      if (msg.type === 'queued') {
        it.status = 'queued'; it.queuePosition = msg.position ?? null;
      } else if (msg.type === 'progress') {
        it.status = 'downloading';
        it.percent = Math.min(90, (Number(msg.percent) || 0) * 0.9);
        it.speed = msg.speed || null; it.eta = msg.eta || null;
      } else if (msg.type === 'processing') {
        it.status = 'processing'; it.percent = 90;
      } else if (msg.type === 'done') {
        try { reader.cancel(); } catch { }
        return msg;
      } else if (msg.type === 'error') {
        try { reader.cancel(); } catch { }
        throw new ApiError(msg.message || 'Erreur', { code: 'SERVER_ERROR' });
      }
      changed();
    }
  }
  throw new ApiError('STREAM_CLOSED', { code: 'STREAM_CLOSED' });
}

function safeFileName(name) {
  return String(name || 'video')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ').trim()
    .replace(/[. ]+$/, '')
    .slice(0, 150) || 'video';
}
async function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, `${base}.${ext}`);
  for (let n = 1; fs.existsSync(candidate) || fs.existsSync(`${candidate}.part`); n++) {
    candidate = path.join(dir, `${base} (${n}).${ext}`);
  }
  return candidate;
}

async function saveFile(it, jobId, signal) {
  it.status = 'saving';
  it.percent = 90;
  changed();
  const res = await api(`${ROUTES.file}${encodeURIComponent(jobId)}`, { raw: true, signal });
  const total = Number(res.headers.get('content-length')) || 0;
  await fsp.mkdir(settings.downloadDir, { recursive: true });
  const base = safeFileName(it.title) + (it.trim ? ` (${it.trim.start}-${it.trim.end})`.replace(/:/g, '.') : '');
  const target = await uniquePath(settings.downloadDir, base, it.ext);
  const part = `${target}.part`;
  const ws = fs.createWriteStream(part);
  let received = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.length;
      if (!ws.write(Buffer.from(value))) await once(ws, 'drain');
      if (total) { it.percent = 90 + (received / total) * 10; pushSoon(); }
    }
    ws.end();
    await once(ws, 'finish');
    await fsp.rename(part, target);
  } catch (e) {
    ws.destroy();
    try { await fsp.unlink(part); } catch { }
    throw e;
  }
  it.filePath = target;
  it.sizeBytes = received;
}

async function runDownload(it) {
  const ctrl = new AbortController();
  active.set(it.id, ctrl);
  Object.assign(it, { status: 'queued', percent: 0, error: null, speed: null, eta: null, queuePosition: null });
  changed();
  try {
    if (IS_LOCAL) {
      await runLocal(it, ctrl.signal);
      Object.assign(it, { status: 'done', percent: 100, finishedAt: Date.now(), speed: null, eta: null });
      notify(it);
      return;
    }
    const start = await api(ROUTES.downloadStart, {
      method: 'POST', signal: ctrl.signal,
      body: {
        url: it.url, quality: it.quality, title: it.title || 'video',
        ...(it.sublang ? { sublang: it.sublang } : {}),
        ...(it.trim ? { trim: true, startTime: it.trim.start, endTime: it.trim.end } : {}),
      },
    });
    const done = await followProgress(it, start.jobId, ctrl.signal);
    if (done.title && !it.title) it.title = done.title;
    await saveFile(it, start.jobId, ctrl.signal);
    Object.assign(it, { status: 'done', percent: 100, finishedAt: Date.now(), speed: null, eta: null });
    notify(it);
  } catch (e) {
    if (e.name === 'AbortError' || ctrl.signal.aborted) {
      it.status = 'canceled'; it.error = null;
    } else {
      it.status = 'error';
      it.error = e.code && e.code !== 'SERVER_ERROR' ? e.code : e.message;
      if (e.code === 'PREMIUM_REQUIRED') refreshSession();
    }
  } finally {
    active.delete(it.id);
    changed();
    pump();
  }
}

// Version locale : yt-dlp + ffmpeg sur ce PC, puis déplacement vers le dossier choisi.
async function runLocal(it, signal) {
  it.status = 'downloading';
  changed();
  const res = await local.download(it, {
    signal,
    onEvent: (m) => {
      if (m.type === 'progress') {
        it.status = 'downloading'; it.percent = Math.min(97, m.percent * 0.97);
        it.speed = m.speed && !/unknown/i.test(m.speed) ? m.speed : null;
        it.eta = m.eta && !/unknown/i.test(m.eta) ? m.eta : null;
      } else if (m.type === 'processing') {
        it.status = 'processing'; it.percent = Math.max(it.percent, 97); it.speed = null; it.eta = null;
      }
      pushSoon();
    },
  });
  try {
    it.status = 'saving'; changed();
    await fsp.mkdir(settings.downloadDir, { recursive: true });
    const base = safeFileName(it.title) + (it.trim ? ` (${it.trim.start}-${it.trim.end})`.replace(/:/g, '.') : '');
    const target = await uniquePath(settings.downloadDir, base, it.ext);
    try { await fsp.rename(res.file, target); }
    catch { await fsp.copyFile(res.file, target); } // autre disque
    it.filePath = target;
    it.sizeBytes = (await fsp.stat(target)).size;
    it.subResult = res.subs; // langue réellement intégrée (ou aucune)
  } finally {
    await res.cleanup();
  }
}

function cancelDownload(id) {
  const it = findItem(id);
  if (!it) return;
  const ctrl = active.get(id);
  if (ctrl) ctrl.abort();
  else if (['waiting', 'analyzing'].includes(it.status)) { it.status = 'canceled'; changed(); }
}
function cancelAll() {
  for (const ctrl of active.values()) ctrl.abort();
  for (const it of items) if (['waiting', 'analyzing'].includes(it.status)) it.status = 'canceled';
  changed();
}

function retryDownload(id) {
  requirePremium();
  const it = findItem(id);
  if (!it || active.has(id)) return;
  Object.assign(it, { status: 'waiting', percent: 0, error: null });
  changed();
  pump();
}

async function removeDownload(id, deleteFile) {
  const it = findItem(id);
  if (!it) return;
  cancelDownload(id);
  if (deleteFile && it.filePath && fs.existsSync(it.filePath)) {
    try { await shell.trashItem(it.filePath); } catch { }
  }
  items = items.filter((x) => x.id !== id);
  changed();
}
function clearFinished() {
  items = items.filter((i) => active.has(i.id) || ['waiting', 'analyzing'].includes(i.status));
  changed();
}

function notify(it) {
  if (!settings.notifications || !Notification.isSupported()) return;
  if (mainWindow && mainWindow.isFocused()) return;
  const fr = settings.language === 'fr';
  const n = new Notification({
    title: fr ? 'Téléchargement terminé' : 'Download complete',
    body: it.title || path.basename(it.filePath || ''),
    icon: path.join(__dirname, 'src', 'assets', 'icon.png'),
    silent: false,
  });
  n.on('click', () => { if (it.filePath) shell.showItemInFolder(it.filePath); });
  n.show();
}

// ─── Téléchargement automatique depuis le presse-papiers ─────────
let clipTimer = null;
let lastClip = '';
const seenClips = new Set();
function startClipboardWatch() {
  clearInterval(clipTimer);
  if (!settings?.autoDownload || !canDownload()) return;
  lastClip = clipboard.readText();
  clipTimer = setInterval(() => {
    const text = clipboard.readText().trim();
    if (!text || text === lastClip) return;
    lastClip = text;
    if (seenClips.has(text) || text.length > 2000 || /\s/.test(text)) return;
    const url = normalizeUrl(text);
    if (!url) return;
    let host; try { host = new URL(url).hostname; } catch { return; }
    if (!AUTO_HOSTS.test(host)) return;
    seenClips.add(text);
    broadcast('toast', { key: 'toast.autoAdded' });
    addDownload(url, settings.defaultFormat).catch(() => { });
  }, 1200);
}

// ─── Profil : photo et nom ───────────────────────────────────────
const AVATAR_FILE = () => path.join(userDir(), 'avatar.png');
function avatarDataUrl() {
  try { return nativeImage.createFromPath(AVATAR_FILE()).toDataURL(); } catch { return null; }
}
function profile() {
  const img = fs.existsSync(AVATAR_FILE()) ? avatarDataUrl() : null;
  return { avatar: img && img !== 'data:image/png;base64,' ? img : null, name: settings.profileName || null };
}
async function choosePhoto() {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: settings.language === 'fr' ? 'Choisir une photo de profil' : 'Choose a profile picture',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] }],
  });
  if (r.canceled || !r.filePaths[0]) return profile();
  const img = nativeImage.createFromPath(r.filePaths[0]);
  if (img.isEmpty()) throw new ApiError('BAD_IMAGE', { code: 'BAD_IMAGE' });
  // Recadrage carré centré puis 320 px : photo nette et fichier léger.
  const { width, height } = img.getSize();
  const side = Math.min(width, height);
  const square = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side })
    .resize({ width: 320, height: 320, quality: 'best' });
  fs.writeFileSync(AVATAR_FILE(), square.toPNG());
  broadcast('profile:changed', profile());
  return profile();
}
function removePhoto() {
  try { fs.unlinkSync(AVATAR_FILE()); } catch { }
  broadcast('profile:changed', profile());
  return profile();
}
function setProfileName(name) {
  settings.profileName = String(name || '').trim().slice(0, 40) || null;
  saveSettings();
  broadcast('profile:changed', profile());
  broadcast('session:changed', publicSession());
  return profile();
}

// ─── Fenêtre ─────────────────────────────────────────────────────
let mainWindow = null;

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 860,
    minHeight: 580,
    frame: false,
    show: false,
    title: 'StreamLoader',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1B1B1F' : '#F6F5F1',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      v8CacheOptions: 'bypassHeatCheck', // démarrages suivants plus rapides
      devTools: IS_DEV,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  // Affiche la fenêtre dès le premier rendu (filet : au plus tard après 1,5 s)
  const reveal = () => { if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show(); };
  mainWindow.once('ready-to-show', reveal);
  setTimeout(reveal, 1500);
  mainWindow.on('maximize', () => broadcast('window:maximized', true));
  mainWindow.on('unmaximize', () => broadcast('window:maximized', false));

  // Aucune navigation hors de l'app : les liens s'ouvrent dans le navigateur.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

// ─── IPC ─────────────────────────────────────────────────────────
// Les erreurs sont renvoyées sous forme { ok:false, code, message } :
// l'interface les traduit elle-même.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (e) { return { ok: false, code: e.code || null, status: e.status || 0, message: e.message }; }
  });
}

function registerIpc() {
  handle('app:info', () => ({
    version: app.getVersion(),
    mode: MODE,
    engine: IS_LOCAL ? local.getVersion() : null,
    siteUrl: SITE_URL,
    defaultServer: DEFAULT_SERVER,
    darkMode: nativeTheme.shouldUseDarkColors,
  }));
  handle('session:get', () => publicSession());
  handle('session:refresh', () => refreshSession());
  handle('session:login', (email, password) => login(email, password));
  handle('session:logout', () => logout());

  handle('settings:get', () => settings);
  handle('settings:set', (patch) => updateSettings(patch));
  handle('settings:chooseFolder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      defaultPath: settings.downloadDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return settings;
    return updateSettings({ downloadDir: r.filePaths[0] });
  });
  handle('settings:openFolder', async () => {
    await fsp.mkdir(settings.downloadDir, { recursive: true });
    return shell.openPath(settings.downloadDir);
  });

  handle('downloads:list', () => items);
  handle('downloads:add', (url, quality) => addDownload(url, quality));
  handle('downloads:analyze', (url) => analyzeLink(url));
  handle('downloads:enqueue', (payload) => enqueueVideo(payload));
  handle('downloads:enqueuePlaylist', (payload) => enqueuePlaylist(payload));

  // Clé API Premium (mêmes routes que la page compte du site)
  handle('apikey:get', () => api('/api/account/api-key'));
  handle('apikey:generate', () => api('/api/account/api-key', { method: 'POST', body: {} }));
  handle('apikey:revoke', () => api('/api/account/api-key', { method: 'DELETE' }));

  handle('profile:get', () => profile());
  handle('profile:choosePhoto', () => choosePhoto());
  handle('profile:removePhoto', () => removePhoto());
  handle('profile:setName', (n) => setProfileName(n));
  handle('engine:update', async () => {
    if (!IS_LOCAL) return null;
    const r = await local.update();
    broadcast('engine:changed', r.version);
    return r;
  });
  handle('downloads:cancel', (id) => cancelDownload(id));
  handle('downloads:retry', (id) => retryDownload(id));
  handle('downloads:remove', (id, deleteFile) => removeDownload(id, Boolean(deleteFile)));
  handle('downloads:clear', () => clearFinished());
  handle('downloads:open', async (id) => {
    const it = findItem(id);
    if (!it?.filePath || !fs.existsSync(it.filePath)) throw new ApiError('FILE_MISSING', { code: 'FILE_MISSING' });
    const err = await shell.openPath(it.filePath);
    if (err) throw new ApiError(err);
  });
  handle('downloads:reveal', (id) => {
    const it = findItem(id);
    if (!it?.filePath || !fs.existsSync(it.filePath)) throw new ApiError('FILE_MISSING', { code: 'FILE_MISSING' });
    shell.showItemInFolder(it.filePath);
  });
  handle('clipboard:write', (text) => clipboard.writeText(String(text || '')));
  handle('clipboard:read', () => clipboard.readText());

  handle('open:site', (p) => {
    const target = new URL(typeof p === 'string' && p.startsWith('/') ? p : PREMIUM_PATH, SITE_URL);
    return shell.openExternal(target.toString());
  });

  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:toggleMaximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
  });
  ipcMain.on('window:close', () => mainWindow?.close());

  nativeTheme.on('updated', () => broadcast('theme:updated', nativeTheme.shouldUseDarkColors));
}

// ─── Démarrage ───────────────────────────────────────────────────
app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(() => {
  loadSettings();
  loadSession();
  loadHistory();
  if (IS_LOCAL) {
    local.init({
      resourcesDir: app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, 'vendor'),
      userDataDir: userDir(),
      nodePath: process.execPath, // Electron sert de moteur JavaScript à yt-dlp
    });
    local.setCookiesBrowser(settings.cookiesBrowser);
    // Version puis mise à jour silencieuse de yt-dlp en arrière-plan
    local.version().then(() => local.update()).then((r) => broadcast('engine:changed', r.version)).catch(() => { });
  }
  registerIpc();
  createWindow();
  if (IS_DEV) console.log('[perf] fenêtre créée à', Math.round(process.uptime() * 1000), 'ms');
  refreshSession().then(() => { startClipboardWatch(); pump(); });
  setInterval(() => refreshSession().then(startClipboardWatch), SESSION_REFRESH_MS);
});

app.on('window-all-closed', () => {
  try { writeJsonAtomic(HISTORY_FILE(), items.slice(0, HISTORY_LIMIT)); } catch { }
  app.quit();
});
