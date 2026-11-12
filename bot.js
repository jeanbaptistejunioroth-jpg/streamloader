/**
 * StreamLoader Telegram Bot — Production Ready
 * Intègre la vérification Premium (SQLite) et la limite de durée.
 */

'use strict';

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');
const net = require('net');
const dns = require('dns').promises;
const axios = require('axios');
const FormData = require('form-data');
const { queries } = require('./database');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Erreur : TELEGRAM_BOT_TOKEN manquant dans .env');
  process.exit(1);
}

// Taille maximale d'un fichier envoyé par le bot.
// L'API publique de Telegram (api.telegram.org) refuse tout fichier de plus de
// 50 Mo envoyé par un bot : c'est une limite côté Telegram, pas un réglage.
// Pour aller au-delà (jusqu'à 2 Go), il faut un « serveur Bot API local » sur le
// VPS et indiquer son adresse dans TELEGRAM_API_URL (voir VPS_DEPLOY_GUIDE.md).
const TELEGRAM_CLOUD_MAX_MB = 50;
const TELEGRAM_LOCAL_MAX_MB = 2000;
const TELEGRAM_API_URL = (process.env.TELEGRAM_API_URL || '').trim().replace(/\/+$/, '');
const requestedMaxMb = Number(process.env.TELEGRAM_MAX_FILE_MB) || (TELEGRAM_API_URL ? 100 : TELEGRAM_CLOUD_MAX_MB);
const MAX_FILE_MB = Math.min(requestedMaxMb, TELEGRAM_API_URL ? TELEGRAM_LOCAL_MAX_MB : TELEGRAM_CLOUD_MAX_MB);
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;

if (!TELEGRAM_API_URL && requestedMaxMb > TELEGRAM_CLOUD_MAX_MB) {
  console.warn(`[bot] TELEGRAM_MAX_FILE_MB=${requestedMaxMb} ignoré : sans TELEGRAM_API_URL (serveur Bot API local), Telegram plafonne les bots à ${TELEGRAM_CLOUD_MAX_MB} Mo.`);
}
console.log(`[bot] Envoi via ${TELEGRAM_API_URL || 'api.telegram.org'} — fichiers jusqu'à ${MAX_FILE_MB} Mo.`);

const bot = new TelegramBot(token, {
  polling: true,
  ...(TELEGRAM_API_URL ? { baseApiUrl: TELEGRAM_API_URL } : {}),
});
const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// Utilisé pour les liens vers les pages légales du site (mêmes pages que le web).
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const LEGAL_LINKS_TEXT =
  `📄 Mentions légales : ${APP_URL}/mentions-legales.html\n` +
  `🔒 Confidentialité : ${APP_URL}/confidentialite.html\n` +
  `📜 CGV/CGU : ${APP_URL}/cgv-cgu.html`;

// Limite pour les gratuits : 4 minutes max (240 secondes)
const FREE_MAX_DURATION = 240; 
const premiumTelegramIds = new Set(
  (process.env.TELEGRAM_PREMIUM_IDS || '').split(',').map(id => id.trim()).filter(Boolean)
);
const pendingDownloads = new Map();
const PENDING_TTL = 15 * 60 * 1000;

const YTDLP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Reconnaissance audio par empreinte sonore (bouton "Musique Officielle").
const SHAZAM_API_KEY = process.env.SHAZAM_API_KEY || '';
const SHAZAM_API_HOST = process.env.SHAZAM_API_HOST || 'shazam-api-free.p.rapidapi.com';

function transcodeVideo(filepath) {
  return new Promise((resolve, reject) => {
    const convertedPath = `${filepath}.converted.mp4`;
    const ffmpeg = spawn('ffmpeg', [
      '-y', '-i', filepath,
      '-vf', 'scale=-2:1080',
      '-c:v', 'libx264', '-profile:v', 'main', '-level', '5.1',
      '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
      convertedPath,
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

function transcodeAudio(filepath, tags = {}) {
  return new Promise((resolve, reject) => {
    const convertedPath = `${filepath}.converted.mp3`;
    // Sans coverPath : -map 0:v? + -c:v copy préservent la miniature déjà
    // embarquée par yt-dlp (--embed-thumbnail), sinon ce second passage
    // ffmpeg (ré-encodage) l'aurait effacée.
    // Avec coverPath (cover officielle Shazam) : on remplace cette miniature
    // par l'image fournie en 2e entrée.
    // Les -metadata explicites (après -map_metadata) forcent le titre/artiste
    // identifiés en Étape A, plutôt que de dépendre des tags — parfois absents
    // ou incomplets — du résultat de recherche trouvé par yt-dlp.
    const args = ['-y', '-i', filepath];
    if (tags.coverPath) {
      args.push('-i', tags.coverPath, '-map', '0:a', '-map', '1:0');
    } else {
      args.push('-map', '0:a', '-map', '0:v?');
    }
    args.push(
      '-c:a', 'libmp3lame', '-q:a', '2', '-c:v', 'copy',
      '-map_metadata', '0', '-id3v2_version', '3',
    );
    if (tags.coverPath) {
      args.push('-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)');
    }
    if (tags.title) args.push('-metadata', `title=${tags.title}`);
    if (tags.artist) args.push('-metadata', `artist=${tags.artist}`);
    args.push(convertedPath);

    const ffmpeg = spawn('ffmpeg', args);
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
 * Étape A (Identification) : extrait les métadonnées (notamment track/artist)
 * d'une vidéo via `yt-dlp --dump-json`, utilisé par le bouton "Musique Officielle".
 */
function ytdlpDumpJson(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', [
      '--dump-json', '--no-warnings', '--no-playlist',
      '--user-agent', YTDLP_UA,
      url
    ]);
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(stderr.slice(-300) || 'yt-dlp a échoué'));
      try { resolve(JSON.parse(stdout.trim().split('\n')[0])); }
      catch (e) { reject(e); }
    });
  });
}

/**
 * Protection SSRF : rejette les URL pointant vers une IP privée/réservée
 * (loopback, réseaux privés, link-local — dont 169.254.169.254 utilisé par les
 * métadonnées cloud). yt-dlp effectue une vraie requête sortante depuis ce
 * serveur vers l'URL fournie par l'utilisateur Telegram.
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
  return true;
}

async function assertPublicHttpUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error('URL invalide'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('URL invalide');
  let addresses;
  try { addresses = await dns.lookup(parsed.hostname, { all: true }); }
  catch { throw new Error('URL invalide'); }
  if (addresses.some(a => isPrivateOrReservedIP(a.address))) throw new Error('URL invalide');
  return parsed;
}

/**
 * Extrait un court échantillon audio (~20s) de la vidéo, à un point choisi
 * pour éviter le tout début (souvent un intro/silence/parole). Utilisé
 * uniquement pour l'identification par empreinte sonore, jamais envoyé à
 * l'utilisateur final.
 */
function ytdlpDownloadSnippet(url, destPath, startSec, endSec) {
  return new Promise((resolve) => {
    const proc = spawn('yt-dlp', [
      '-f', 'bestaudio/best', '--extract-audio', '--audio-format', 'mp3',
      '--download-sections', `*${startSec}-${endSec}`,
      '-o', destPath,
      '--no-warnings', '--no-playlist',
      '--user-agent', YTDLP_UA,
      url
    ]);
    proc.on('close', code => resolve(code === 0 && fs.existsSync(destPath)));
    proc.on('error', () => resolve(false));
  });
}

/**
 * Reconnaissance audio par empreinte sonore (API Shazam via RapidAPI) : bien
 * plus fiable qu'un simple parsing de titre, puisqu'elle "écoute" réellement
 * l'extrait fourni. Retourne { title, artist, cover } avec la cover officielle
 * (catalogue Apple Music), ou null si aucune correspondance / clé absente.
 */
async function shazamRecognize(snippetPath) {
  if (!SHAZAM_API_KEY) return null;
  const form = new FormData();
  form.append('upload_file', fs.createReadStream(snippetPath));

  const res = await axios.post(`https://${SHAZAM_API_HOST}/shazam/recognize/`, form, {
    headers: {
      ...form.getHeaders(),
      'x-rapidapi-key': SHAZAM_API_KEY,
      'x-rapidapi-host': SHAZAM_API_HOST,
    },
    maxBodyLength: Infinity,
    timeout: 15000,
  });

  const track = res.data?.result?.track;
  if (!track?.title) return null;
  return {
    title: track.title,
    artist: track.subtitle || null,
    cover: track.images?.coverarthq || track.images?.coverart || null,
  };
}

/**
 * Repli d'identification quand `track`/`artist` sont absents des métadonnées
 * (le cas le plus fréquent : même les clips officiels VEVO n'exposent quasiment
 * jamais ces champs via yt-dlp). On tente d'extraire "Artiste - Titre" du titre
 * de la vidéo, après avoir retiré les mentions parasites en fin de titre
 * ("(Official Video)", "(Lyric Video)", année, etc.). Volontairement
 * conservateur : si le titre n'a pas ce format simple (ex. légendes TikTok
 * pleines de hashtags), on renvoie null plutôt que de risquer une identification
 * erronée.
 */
function parseArtistTrackFromTitle(title) {
  if (!title) return null;
  let clean = title;
  let prev;
  do {
    prev = clean;
    clean = clean.replace(/\s*[\[(][^[\]()]*[\])]\s*$/, '').trim();
  } while (clean !== prev);

  // Espace obligatoire de chaque côté du tiret pour ne pas couper un nom
  // composé comme "Anne-Marie" au milieu.
  const match = clean.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (match && match[1].trim() && match[2].trim()) {
    return { artist: match[1].trim(), track: match[2].trim() };
  }
  return null;
}

const pendingCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, item] of pendingDownloads) {
    if (item.expiresAt <= now) pendingDownloads.delete(key);
  }
}, 60 * 1000);
pendingCleanupTimer.unref();

console.log('🤖 Bot Telegram StreamLoader démarré avec succès...');

function answerCallback(queryId, options) {
  return bot.answerCallbackQuery(queryId, options).catch(() => undefined);
}

bot.on('polling_error', error => {
  console.error('[Telegram polling]', error.code || 'ERROR', error.message || 'Erreur inconnue');
});

bot.on('error', error => {
  console.error('[Telegram bot]', error.message);
});

// Commande /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `👋 Salut ! Bienvenue sur **StreamLoader Bot** 🚀\n\n` +
    `Envoie-moi le lien d'une vidéo (YouTube, TikTok, Instagram...) et télécharge-la instantanément.\n\n` +
    `💡 *Astuce :* Les membres Premium de notre site profitent de téléchargements illimités et sans restriction de durée !\n\n` +
    `En utilisant ce bot, tu acceptes nos CGU : ${APP_URL}/cgv-cgu.html`,
    { parse_mode: 'Markdown' }
  );
});

// Commande /help
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `🆘 **Aide StreamLoader Bot**\n\n` +
    `Envoie-moi simplement le lien d'une vidéo (YouTube, TikTok, Instagram, etc.), puis choisis le format souhaité dans le menu qui apparaît.\n\n` +
    `Commandes disponibles :\n` +
    `/start — présentation du bot\n` +
    `/help — cette aide\n` +
    `/legal — mentions légales, confidentialité, CGV/CGU\n\n` +
    `⚠️ Ce service est soumis au respect du droit d'auteur : tu es seul responsable de disposer des droits nécessaires sur les contenus que tu télécharges.\n\n` +
    `Plus d'infos : ${APP_URL}/cgv-cgu.html`,
    { parse_mode: 'Markdown' }
  );
});

// Commande /legal — liens vers les textes légaux
bot.onText(/\/legal/, (msg) => {
  bot.sendMessage(msg.chat.id, LEGAL_LINKS_TEXT);
});

// Écoute des liens envoyés au bot
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || text.startsWith('/')) return;

  try {
    await assertPublicHttpUrl(text);
  } catch {
    return bot.sendMessage(chatId, '❌ Envoie-moi un lien valide (URL commençant par http ou https).');
  }

  const analyzingMsg = await bot.sendMessage(chatId, '🔍 Analyse de la vidéo en cours...');

  // Extraction des infos de la vidéo via yt-dlp
  const proc = spawn('yt-dlp', [
    '--dump-single-json', '--no-warnings', '--no-playlist',
    '--user-agent', YTDLP_UA,
    text
  ]);

  let stdout = '', stderr = '';
  proc.stdout.on('data', d => { stdout += d; });
  proc.stderr.on('data', d => { stderr += d; });
  proc.on('error', () => {
    bot.editMessageText('❌ yt-dlp est indisponible sur le serveur.', {
      chat_id: chatId,
      message_id: analyzingMsg.message_id
    });
  });

  proc.on('close', async (code) => {
    if (code !== 0) {
      return bot.editMessageText('❌ Impossible d\'analyser cette vidéo. Vérifie le lien.', {
        chat_id: chatId,
        message_id: analyzingMsg.message_id
      });
    }

    try {
      const info = JSON.parse(stdout);
      const title = info.title || 'video';
      const duration = info.duration || 0; // en secondes

      const isPremium = premiumTelegramIds.has(String(msg.from.id));

      // Application de la restriction de durée pour les gratuits
      if (!isPremium && duration > FREE_MAX_DURATION) {
        const minutes = Math.ceil(duration / 60);
        await bot.deleteMessage(chatId, analyzingMsg.message_id);
        return bot.sendMessage(
          chatId,
          `⚠️ *Vidéo trop longue (${minutes} min)*\n\n` +
          `Le plan gratuit limite les téléchargements à 4 minutes maximum.\n` +
          `Passe au plan **Premium** sur notre site web pour débloquer les vidéos illimitées ! ⚡`,
          { parse_mode: 'Markdown' }
        );
      }

      // Proposer les formats si la condition est validée
      const downloadKey = randomUUID().replace(/-/g, '');
      pendingDownloads.set(downloadKey, { url: text, chatId, expiresAt: Date.now() + PENDING_TTL });
      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎵 Musique Officielle (Complète)', callback_data: `dl|music|${downloadKey}` }],
            [{ text: '🎬 Vidéo (MP4)', callback_data: `dl|vid|${downloadKey}` }],
            [{ text: '🔊 Audio de la vidéo (MP3)', callback_data: `dl|aud|${downloadKey}` }]
          ]
        }
      };

      await bot.deleteMessage(chatId, analyzingMsg.message_id);
      bot.sendMessage(chatId, `📹 *${title}*\n\nQue voulez-vous télécharger ?`, {
        parse_mode: 'Markdown',
        ...keyboard
      });

    } catch {
      bot.editMessageText('❌ Erreur lors du traitement des données.', {
        chat_id: chatId,
        message_id: analyzingMsg.message_id
      });
    }
  });
});

// Téléchargement et envoi du fichier
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const [action, type, downloadKey] = String(query.data || '').split('|');
  const pending = pendingDownloads.get(downloadKey);
  const url = pending?.url;

  if (action !== 'dl' || !pending || pending.chatId !== chatId || pending.expiresAt <= Date.now()) {
    return answerCallback(query.id, { text: 'Ce lien a expiré. Renvoie l’URL.' });
  }

  if (action === 'dl' && pending && pending.chatId === chatId && pending.expiresAt > Date.now()) {
    pendingDownloads.delete(downloadKey);
    const clientKey = `telegram:${chatId}`;
    const isPremium = premiumTelegramIds.has(String(query.from?.id || chatId));
    if (!isPremium && queries.countDailyDownloads.get(clientKey).count >= 30) {
      return answerCallback(query.id, { text: 'Limite gratuite de 30 téléchargements atteinte aujourd’hui.' });
    }

    answerCallback(query.id, { text: 'Traitement en cours...' });
    const statusMsg = await bot.sendMessage(
      chatId,
      type === 'music' ? '🎧 Identification de la musique par empreinte audio...' : '⏳ Téléchargement et conversion en cours...'
    );

    const jobId = randomUUID();
    const isAudio = type === 'aud' || type === 'music';
    // Dossier temporaire dédié à cette requête : le nom final étant généré par
    // yt-dlp à partir du titre (%(title)s.%(ext)s), on isole chaque téléchargement
    // dans son propre dossier pour retrouver le fichier sans ambiguïté ensuite.
    // assetsDir est séparé et sert uniquement à l'identification (échantillon
    // audio + cover) : il ne doit jamais se mêler au fichier final de jobDir.
    const jobDir = path.join(TMP_DIR, jobId);
    const assetsDir = path.join(TMP_DIR, `${jobId}_assets`);
    fs.mkdirSync(jobDir, { recursive: true });
    const cleanupJobDir = () => {
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(assetsDir, { recursive: true, force: true }); } catch {}
    };

    // ── Bouton "Musique Officielle" : on identifie d'abord la chanson, puis on
    // télécharge la version officielle complète via une recherche YouTube
    // dédiée (au lieu de l'URL d'origine). Si aucune musique n'est identifiée,
    // on s'arrête ici.
    let downloadInput = url;
    let musicTags = null;
    if (type === 'music') {
      let info;
      try {
        info = await ytdlpDumpJson(url);
      } catch {
        cleanupJobDir();
        return bot.editMessageText('❌ Impossible d\'analyser cette vidéo pour identifier la musique.', {
          chat_id: chatId,
          message_id: statusMsg.message_id
        });
      }

      // Étape A, méthode 1 : reconnaissance par empreinte audio (Shazam) sur un
      // court échantillon — bien plus fiable qu'un texte, puisqu'elle "écoute"
      // réellement le son. On évite les toutes premières secondes (souvent une
      // intro/silence/parole avant que la musique ne démarre vraiment).
      fs.mkdirSync(assetsDir, { recursive: true });
      const duration = info.duration || 0;
      const snippetStart = duration > 30 ? 10 : 0;
      const snippetEnd = duration > 0 ? Math.min(duration, snippetStart + 20) : snippetStart + 20;
      const snippetPath = path.join(assetsDir, 'snippet.mp3');

      let track = null, artist = null, coverUrl = null;
      const snippetOk = await ytdlpDownloadSnippet(url, snippetPath, snippetStart, snippetEnd);
      if (snippetOk) {
        try {
          const shazamResult = await shazamRecognize(snippetPath);
          if (shazamResult) {
            track = shazamResult.title;
            artist = shazamResult.artist;
            coverUrl = shazamResult.cover;
          }
        } catch (e) {
          console.error('[shazam]', e.response?.data || e.message);
        }
      }

      // Étape A, méthode 2 (repli) : métadonnées structurées (track/artist —
      // rares) puis analyse conservatrice du titre de la vidéo.
      if (!track) {
        track = info.track || null;
        artist = info.artist || null;
      }
      if (!track) {
        const parsed = parseArtistTrackFromTitle(info.title);
        if (parsed) { track = parsed.track; artist = parsed.artist; }
      }

      if (!track) {
        cleanupJobDir();
        return bot.editMessageText(
          '❌ Aucune musique officielle n\'a pu être identifiée dans cette vidéo. Vous pouvez toujours utiliser l\'option "Audio de la vidéo".',
          { chat_id: chatId, message_id: statusMsg.message_id }
        );
      }

      // Cover officielle (catalogue Apple Music via Shazam) : téléchargée
      // seulement si l'identification par empreinte a réussi. À défaut, la
      // miniature de la vidéo trouvée par la recherche YouTube sera utilisée.
      let coverPath = null;
      if (coverUrl) {
        try {
          const resp = await axios.get(coverUrl, { responseType: 'arraybuffer', timeout: 10000 });
          coverPath = path.join(assetsDir, 'cover.jpg');
          fs.writeFileSync(coverPath, resp.data);
        } catch { coverPath = null; }
      }

      musicTags = { title: track, artist: artist || null, coverPath };
      downloadInput = 'ytsearch1:' + (artist ? artist + ' ' : '') + track + ' official audio';
      await bot.editMessageText(
        `🎵 Musique identifiée : *${artist ? artist + ' - ' : ''}${track}*\n\n⏳ Téléchargement en cours...`,
        { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
      );
    }

    const outputTemplate = path.join(jobDir, '%(title)s.%(ext)s');
    const downloadLog = queries.logDownload.run(null, clientKey, url, type, 'Telegram', 0);

    // Configuration stricte des arguments yt-dlp pour une compatibilité universelle
    const args = [
      '-o', outputTemplate,
      // Assainit le nom de fichier (accents, émojis, espaces, symboles) pour
      // éviter tout problème de création de fichier ou d'envoi sur Telegram.
      '--restrict-filenames',
      '--no-warnings',
      '--no-playlist'
    ];

    if (type === 'music') {
      // Fichier audio "parfait" : miniature + métadonnées embarquées.
      args.push(
        '-f', 'bestaudio/best', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0',
        '--embed-thumbnail', '--embed-metadata'
      );
    } else if (isAudio) {
      // Extraction simple du son exact de la vidéo, avec sa miniature.
      args.push('-f', 'bestaudio/best', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0', '--embed-thumbnail');
    } else {
      // 1. Meilleure vidéo compatible max 1080p pour respecter les quotas Telegram
      args.push('-f', 'bestvideo[height=1080]+bestaudio/bestvideo+bestaudio/best');
      // 2. Transcodage universel H.264 (yuv420p) + AAC pour lecture instantanée sur iPhone/iOS et Android
      args.push(
        '--merge-output-format', 'mp4',
        '--recode-video', 'mp4',
        '--postprocessor-args', 'VideoConvertor:-vf scale=-2:1080 -c:v libx264 -profile:v main -level 4.1 -pix_fmt yuv420p -preset faster -c:a aac -b:a 192k -movflags +faststart'
      );
    }

    // User-agent anti-blocage
    // IMPORTANT : on n'impose AUCUN client YouTube spécifique (pas de
    // --extractor-args youtube:player_client=...). Le client par défaut de yt-dlp
    // expose la pleine gamme de résolutions, alors que "android" plafonne à 360p/720p.
    args.push('--user-agent', YTDLP_UA);
    args.push(downloadInput);

    const dlProc = spawn('yt-dlp', args);

    dlProc.on('error', () => {
      bot.editMessageText('❌ yt-dlp est indisponible sur le serveur.', {
        chat_id: chatId,
        message_id: statusMsg.message_id
      });
      cleanupJobDir();
    });

    dlProc.on('close', async (code) => {
      // Le nom exact du fichier est déterminé par yt-dlp (titre + extension) :
      // on récupère le seul fichier présent dans le dossier dédié à ce job.
      const producedFiles = code === 0 ? (() => { try { return fs.readdirSync(jobDir); } catch { return []; } })() : [];

      if (code === 0 && producedFiles.length > 0) {
        const originalFilename = producedFiles[0];
        const filepath = path.join(jobDir, originalFilename);

        try {
          if (isAudio) await transcodeAudio(filepath, musicTags || {});
          else await transcodeVideo(filepath);
        } catch {
          try { queries.updateDownloadStatus.run('error', downloadLog.lastInsertRowid); } catch {}
          cleanupJobDir();
          return bot.editMessageText('❌ Conversion vidéo incompatible avec Telegram/iPhone.', {
            chat_id: chatId,
            message_id: statusMsg.message_id
          });
        }
        try { queries.updateDownloadStatus.run('done', downloadLog.lastInsertRowid); } catch {}

        // Inutile de tenter l'envoi d'un fichier que Telegram refusera : on le
        // dit tout de suite, avec la taille réelle et le lien vers le site.
        const tooBigMessage = (sizeBytes) =>
          `❌ Fichier trop lourd pour Telegram : ${(sizeBytes / 1024 / 1024).toFixed(0)} Mo (maximum ${MAX_FILE_MB} Mo).\n\n` +
          `Télécharge-le plutôt sur le site, sans limite de taille :\n${APP_URL}`;
        let sizeBytes = 0;
        try { sizeBytes = fs.statSync(filepath).size; } catch {}
        if (sizeBytes > MAX_FILE_BYTES) {
          cleanupJobDir();
          return bot.editMessageText(tooBigMessage(sizeBytes), { chat_id: chatId, message_id: statusMsg.message_id });
        }

        try {
          await bot.editMessageText('📤 Envoi du fichier sur Telegram...', {
            chat_id: chatId,
            message_id: statusMsg.message_id
          });

          // fileOptions.filename impose le nom d'origine (titre de la vidéo) tel
          // que vu par l'utilisateur sur Telegram, peu importe le chemin local.
          if (isAudio) {
            await bot.sendAudio(chatId, filepath, {}, { filename: originalFilename, contentType: 'audio/mpeg' });
          } else {
            await bot.sendVideo(chatId, filepath, { supports_streaming: true }, { filename: originalFilename, contentType: 'video/mp4' });
          }

          bot.deleteMessage(chatId, statusMsg.message_id);
        } catch (err) {
          console.error('[bot] Échec de l\'envoi sur Telegram :', err.message);
          const refusedForSize = err.response?.statusCode === 413 || /too large|too big/i.test(err.message || '');
          bot.sendMessage(chatId, refusedForSize
            ? tooBigMessage(sizeBytes)
            : '❌ L\'envoi sur Telegram a échoué. Réessaie dans un instant.');
        }
        cleanupJobDir();
      } else {
        try { queries.updateDownloadStatus.run('error', downloadLog.lastInsertRowid); } catch {}
        bot.editMessageText('❌ Erreur lors du téléchargement.', {
          chat_id: chatId,
          message_id: statusMsg.message_id
        });
        cleanupJobDir();
      }
    });
  }
});
