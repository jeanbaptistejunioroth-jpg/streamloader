const Database = require('better-sqlite3');
const path = require('path');
const fs   = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'streamloader.db');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    email       TEXT UNIQUE NOT NULL,
    password    TEXT NOT NULL,
    plan        TEXT NOT NULL DEFAULT 'free',
    premium_until TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    provider    TEXT NOT NULL,
    amount      INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS downloads_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT REFERENCES users(id),
    client_key  TEXT,
    url         TEXT NOT NULL,
    format      TEXT,
    title       TEXT,
    status      TEXT DEFAULT 'pending',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    client_key  TEXT,
    rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment     TEXT,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_tx_user     ON transactions(user_id);
  CREATE INDEX IF NOT EXISTS idx_dl_user     ON downloads_log(user_id);
  CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status, created_at);
`);

try { db.exec('ALTER TABLE downloads_log ADD COLUMN client_key TEXT'); } catch { }
try { db.exec('ALTER TABLE transactions ADD COLUMN plan TEXT NOT NULL DEFAULT \'monthly\''); } catch { }
try { db.exec('ALTER TABLE users ADD COLUMN premium_until TEXT'); } catch { }
try { db.exec('ALTER TABLE downloads_log ADD COLUMN subtitled INTEGER DEFAULT 0'); } catch { }
try { db.exec('ALTER TABLE users ADD COLUMN trim_trials_used INTEGER NOT NULL DEFAULT 0'); } catch { }
// Clé API (réservée aux comptes Premium). On ne stocke JAMAIS la clé en clair :
// seul son hash SHA-256 est en base (comme un mot de passe). Le "prefix" est
// un extrait sûr à afficher (ex. "sl_a1b2c3d4…") pour que l'utilisateur
// reconnaisse sa clé sans qu'on ait besoin de la redonner en entier.
try { db.exec('ALTER TABLE users ADD COLUMN api_key_hash TEXT'); } catch { }
try { db.exec('ALTER TABLE users ADD COLUMN api_key_prefix TEXT'); } catch { }
try { db.exec('ALTER TABLE users ADD COLUMN api_key_created_at TEXT'); } catch { }
// Copie chiffrée (AES-256-GCM) de la clé, pour que son propriétaire connecté
// puisse la recopier à tout moment. L'authentification passe toujours par le hash.
try { db.exec('ALTER TABLE users ADD COLUMN api_key_encrypted TEXT'); } catch { }
// Playlists lancées par les comptes gratuits (quota : une par semaine).
// playlist_key identifie la playlist (ex. "yt:PLxxxx") pour pouvoir reprendre
// la même playlist dans la semaine sans consommer un nouveau quota.
db.exec(`
  CREATE TABLE IF NOT EXISTS playlist_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      TEXT NOT NULL REFERENCES users(id),
    playlist_key TEXT NOT NULL,
    item_count   INTEGER,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_playlist_user ON playlist_log(user_id, created_at);
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_dl_client ON downloads_log(client_key, created_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_users_api_key_hash ON users(api_key_hash)');

const queries = {
  // Users
  createUser:          db.prepare(`INSERT INTO users (id, email, password) VALUES (?,?,?)`),
  getUserByEmail:      db.prepare(`SELECT id, email, password, CASE WHEN plan='premium' AND premium_until IS NOT NULL AND premium_until <= datetime('now') THEN 'free' ELSE plan END AS plan, premium_until, trim_trials_used, created_at, updated_at FROM users WHERE email = ?`),
  getUserById:         db.prepare(`SELECT id, email, CASE WHEN plan='premium' AND premium_until IS NOT NULL AND premium_until <= datetime('now') THEN 'free' ELSE plan END AS plan, premium_until, trim_trials_used, created_at FROM users WHERE id = ?`),
  upgradeToPremium:    db.prepare(`UPDATE users SET plan='premium', premium_until=datetime(CASE WHEN premium_until IS NOT NULL AND premium_until > datetime('now') THEN premium_until ELSE datetime('now') END, '+' || ? || ' months'), updated_at=datetime('now') WHERE id=?`),
  incrementTrimTrial:  db.prepare(`UPDATE users SET trim_trials_used = trim_trials_used + 1, updated_at=datetime('now') WHERE id=?`),

  // Clé API Premium — voir commentaire de migration plus haut.
  setApiKey:           db.prepare(`UPDATE users SET api_key_hash=?, api_key_prefix=?, api_key_encrypted=?, api_key_created_at=datetime('now'), updated_at=datetime('now') WHERE id=?`),
  revokeApiKey:        db.prepare(`UPDATE users SET api_key_hash=NULL, api_key_prefix=NULL, api_key_encrypted=NULL, api_key_created_at=NULL, updated_at=datetime('now') WHERE id=?`),
  getApiKeyInfo:       db.prepare(`SELECT api_key_prefix, api_key_encrypted, api_key_created_at FROM users WHERE id = ?`),
  // Le statut 'premium' est recalculé à la volée (expiration comprise) : si
  // premium_until est dépassé, plan repasse à 'free' ICI MÊME, donc une clé
  // API se désactive automatiquement dès l'expiration — pas besoin de tâche
  // planifiée pour la révoquer activement.
  getUserByApiKeyHash: db.prepare(`SELECT id, email, CASE WHEN plan='premium' AND premium_until IS NOT NULL AND premium_until <= datetime('now') THEN 'free' ELSE plan END AS plan, premium_until, trim_trials_used, created_at FROM users WHERE api_key_hash = ?`),

  // Transactions
  createTransaction:   db.prepare(`INSERT INTO transactions (id, user_id, provider, amount, plan) VALUES (?,?,?,?,?)`),
  getTransaction:      db.prepare(`SELECT * FROM transactions WHERE id = ?`),
  completeTransaction: db.prepare(`UPDATE transactions SET status='completed', updated_at=datetime('now') WHERE id=?`),

  // Downloads
  logDownload:         db.prepare(`INSERT INTO downloads_log (user_id, client_key, url, format, title, subtitled) VALUES (?,?,?,?,?,?)`),
  updateDownloadStatus:db.prepare(`UPDATE downloads_log SET status=? WHERE id=?`),
  countDailyDownloads: db.prepare(`SELECT COUNT(*) AS count FROM downloads_log WHERE client_key = ? AND created_at >= datetime('now', 'start of day')`),
  countDailySubtitleDownloads: db.prepare(`SELECT COUNT(*) AS count FROM downloads_log WHERE client_key = ? AND subtitled = 1 AND created_at >= datetime('now', 'start of day')`),

  // Playlists (quota hebdomadaire des comptes gratuits)
  logPlaylist:         db.prepare(`INSERT INTO playlist_log (user_id, playlist_key, item_count) VALUES (?,?,?)`),
  // Dernière playlist lancée dans les 7 derniers jours, avec la date à laquelle le quota se libère.
  getRecentPlaylist:   db.prepare(`SELECT playlist_key, created_at, datetime(created_at, '+7 days') AS next_at FROM playlist_log WHERE user_id = ? AND created_at > datetime('now', '-7 days') ORDER BY created_at DESC LIMIT 1`),

  // Avis (reviews) — modération avant publication
  createReview:        db.prepare(`INSERT INTO reviews (client_key, rating, comment) VALUES (?,?,?)`),
  countPendingReviewsToday: db.prepare(`SELECT COUNT(*) AS count FROM reviews WHERE client_key = ? AND created_at >= datetime('now', 'start of day')`),
  listPendingReviews:  db.prepare(`SELECT id, rating, comment, created_at FROM reviews WHERE status='pending' ORDER BY created_at ASC`),
  approveReview:       db.prepare(`UPDATE reviews SET status='approved' WHERE id=?`),
  rejectReview:        db.prepare(`UPDATE reviews SET status='rejected' WHERE id=?`),
  getReviewStats:      db.prepare(`SELECT COUNT(*) AS count, AVG(rating) AS average FROM reviews WHERE status='approved'`),
  listApprovedReviews: db.prepare(`SELECT rating, comment, created_at FROM reviews WHERE status='approved' ORDER BY created_at DESC LIMIT ?`),
};

module.exports = { db, queries };
