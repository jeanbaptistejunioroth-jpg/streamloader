// ─────────────────────────────────────────────────────────────────
//  StreamLoader Desktop — moteur LOCAL (version personnelle)
//
//  Même logique que le serveur StreamLoader (analyse, formats, sous-titres,
//  découpage, finalisation H.264/AAC), mais yt-dlp et ffmpeg tournent
//  directement sur ce PC. Aucune limite, aucun compte nécessaire.
// ─────────────────────────────────────────────────────────────────

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const PLAYLIST_MAX = 300;
const HEIGHTS = { '4k': 2160, '2160p': 2160, '1440p': 1440, '1080p': 1080, '720p': 720, '480p': 480, '360p': 360 };

let BIN = { ytdlp: 'yt-dlp', ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', ffmpegDir: null };
let ytdlpVersion = null;
// Cookies du navigateur (option « Utiliser mon compte YouTube ») : contourne le
// « Sign in to confirm you're not a bot » que YouTube impose parfois.
let cookiesBrowser = null;
function setCookiesBrowser(b) { cookiesBrowser = ['firefox', 'edge', 'chrome', 'brave', 'opera', 'vivaldi'].includes(b) ? b : null; }
const cookieArgs = () => (cookiesBrowser ? ['--cookies-from-browser', cookiesBrowser] : []);
// Moteur JavaScript exigé par yt-dlp pour YouTube : on réutilise le Node.js
// intégré à l'application (Electron lancé avec ELECTRON_RUN_AS_NODE=1).
let jsRuntime = null;
const jsArgs = () => (jsRuntime ? ['--js-runtimes', `node:${jsRuntime}`] : []);

// ─── Binaires ────────────────────────────────────────────────────
// yt-dlp est copié dans le dossier utilisateur pour pouvoir se mettre à jour
// lui-même (YouTube change souvent, une version récente est indispensable).
function init({ resourcesDir, userDataDir, nodePath = null, log = () => { } }) {
  jsRuntime = nodePath;
  const ffmpegDir = path.join(resourcesDir, 'ffmpeg');
  const bundledYtdlp = path.join(resourcesDir, 'yt-dlp.exe');
  const userBin = path.join(userDataDir, 'bin');
  const userYtdlp = path.join(userBin, 'yt-dlp.exe');
  try {
    fs.mkdirSync(userBin, { recursive: true });
    const bundledStat = fs.existsSync(bundledYtdlp) ? fs.statSync(bundledYtdlp) : null;
    const userStat = fs.existsSync(userYtdlp) ? fs.statSync(userYtdlp) : null;
    // Copie au premier lancement (ou si la version embarquée est plus récente)
    if (bundledStat && (!userStat || bundledStat.mtimeMs > userStat.mtimeMs + 1000)) fs.copyFileSync(bundledYtdlp, userYtdlp);
  } catch (e) { log('copie yt-dlp', e.message); }
  BIN = {
    ytdlp: fs.existsSync(userYtdlp) ? userYtdlp : bundledYtdlp,
    ffmpeg: path.join(ffmpegDir, 'ffmpeg.exe'),
    ffprobe: path.join(ffmpegDir, 'ffprobe.exe'),
    ffmpegDir,
  };
  return BIN;
}

function run(bin, args, { signal, onLine, onErrLine } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ELECTRON_RUN_AS_NODE: '1' },
    });
    let stdout = '', stderr = '', outBuf = '', errBuf = '';
    const onAbort = () => { try { proc.kill(); } catch { } };
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    proc.stdout.on('data', (c) => {
      const s = c.toString('utf8'); stdout += s;
      if (onLine) { outBuf += s; const lines = outBuf.split(/\r?\n|\r/); outBuf = lines.pop(); lines.forEach(onLine); }
    });
    proc.stderr.on('data', (c) => {
      const s = c.toString('utf8'); stderr += s;
      if (onErrLine) { errBuf += s; const lines = errBuf.split(/\r?\n|\r/); errBuf = lines.pop(); lines.forEach(onErrLine); }
    });
    proc.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e); });
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) { const e = new Error('Annulé'); e.name = 'AbortError'; return reject(e); }
      resolve({ code, stdout, stderr });
    });
  });
}

async function version() {
  try { const r = await run(BIN.ytdlp, ['--version']); ytdlpVersion = r.stdout.trim() || null; } catch { ytdlpVersion = null; }
  return ytdlpVersion;
}

// Mise à jour de yt-dlp (silencieuse, au démarrage ou à la demande)
async function update() {
  try {
    const r = await run(BIN.ytdlp, ['-U']);
    await version();
    return { ok: r.code === 0, version: ytdlpVersion, output: (r.stdout + r.stderr).trim().split('\n').slice(-1)[0] };
  } catch (e) { return { ok: false, version: ytdlpVersion, output: e.message }; }
}

// ─── Messages d'erreur (mêmes textes que le serveur) ─────────────
function parseYtdlpError(stderr = '') {
  const s = stderr.toLowerCase();
  if (s.includes('http error 429') || s.includes('too many requests')) return 'La plateforme limite temporairement les requêtes (erreur 429). Patiente quelques minutes puis réessaie.';
  if (s.includes('private video') || s.includes('video is private')) return 'Cette vidéo est privée et inaccessible.';
  if (s.includes('age-restricted') || s.includes('age restriction') || s.includes('confirm your age')) return 'Cette vidéo est réservée aux adultes (restriction d\'âge).';
  if (s.includes('not available in your country') || s.includes('geo-blocked')) return 'Vidéo non disponible dans ta région.';
  if (s.includes('this video is unavailable') || s.includes('video unavailable')) return 'Vidéo indisponible (supprimée ou retirée).';
  if (s.includes('unsupported url') || s.includes('no supported')) return 'URL non reconnue ou site non supporté.';
  if (s.includes('copyright') || s.includes('has been removed')) return 'Vidéo retirée pour violation de droits d\'auteur.';
  if (s.includes('not a bot')) return 'YouTube demande une vérification (« confirme que tu n\'es pas un robot »). Active « Cookies du navigateur » dans les Paramètres, ou réessaie plus tard.';
  if (s.includes('could not copy') && s.includes('cookie')) return 'Impossible de lire les cookies du navigateur : ferme-le complètement puis réessaie (ou choisis Firefox).';
  if (s.includes('sign in') || s.includes('login required')) return 'Cette vidéo requiert une connexion au compte de la plateforme.';
  if (s.includes('members-only') || s.includes('paid content')) return 'Contenu réservé aux membres / payant.';
  if (s.includes('getaddrinfo') || s.includes('network') || s.includes('connection refused') || s.includes('timed out')) return 'Erreur réseau. Vérifie ta connexion internet et réessaie.';
  if (s.includes('http error 403')) return 'Accès refusé par la plateforme (erreur 403). Mets yt-dlp à jour dans les Paramètres puis réessaie.';
  if (s.includes('http error 404')) return 'Vidéo introuvable (erreur 404). Vérifie l\'URL.';
  const last = stderr.trim().split('\n').filter((l) => /ERROR/i.test(l)).pop();
  return last ? last.replace(/^.*ERROR:\s*/i, '').slice(0, 220) : 'Impossible d\'analyser cette vidéo. Vérifie l\'URL et réessaie.';
}

// ─── Analyse ─────────────────────────────────────────────────────
async function analyze(url) {
  const r = await run(BIN.ytdlp, [
    '--dump-single-json', '--no-warnings', '--no-playlist',
    '--flat-playlist', '--playlist-end', String(PLAYLIST_MAX + 1),
    ...cookieArgs(), ...jsArgs(), '--user-agent', UA, url,
  ]);
  if (r.code !== 0) throw new Error(parseYtdlpError(r.stderr));
  let data;
  try { data = JSON.parse(r.stdout); } catch { throw new Error('Réponse yt-dlp invalide. Réessaie.'); }

  if (data._type === 'playlist') {
    const listed = (Array.isArray(data.entries) ? data.entries : []).slice(0, PLAYLIST_MAX);
    const entries = listed.map((e) => {
      let u = e.url || e.webpage_url || '';
      if (!/^https?:\/\//i.test(u) && e.id && /youtube/i.test(e.ie_key || data.extractor_key || '')) u = `https://www.youtube.com/watch?v=${e.id}`;
      return { id: e.id || null, title: e.title ? String(e.title).slice(0, 200) : null, duration: e.duration || null, url: u };
    }).filter((e) => e.title && /^https?:\/\//i.test(e.url));
    if (!entries.length) throw new Error('Cette playlist est vide, ou ses vidéos ne sont pas accessibles.');
    return {
      playlist: {
        title: data.title || 'Playlist',
        uploader: data.uploader || data.channel || null,
        webpage: data.webpage_url || url,
        total: data.playlist_count || listed.length,
        unavailable: listed.length - entries.length,
        entries,
      },
    };
  }

  return {
    data: {
      title: data.title || 'Sans titre',
      duration: data.duration || null,
      uploader: data.uploader || data.channel || 'Inconnu',
      thumbnail: data.thumbnail || null,
      subtitles: [...new Set([...Object.keys(data.subtitles || {}), ...Object.keys(data.automatic_captions || {})])],
      extractor: data.extractor_key || '?',
      webpage: data.webpage_url || url,
      formats: (data.formats || [])
        .filter((f) => f.vcodec !== 'images' && f.ext !== 'mhtml')
        .map((f) => ({
          id: f.format_id, ext: f.ext, height: f.height || null, width: f.width || null,
          vcodec: f.vcodec !== 'none' ? f.vcodec : null, acodec: f.acodec !== 'none' ? f.acodec : null,
          filesize: f.filesize || f.filesize_approx || null,
        })),
    },
  };
}

// ─── Téléchargement ──────────────────────────────────────────────
function videoSelector(h) {
  return [
    `bestvideo[height<=${h}][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${h}]+bestaudio`,
    `best[height<=${h}]`,
  ].join('/');
}

function parseProgress(line) {
  const m = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\s*\S+)\s+at\s+([\d.]+\s*\S+\/s|Unknown\s*\S*)(?:\s+ETA\s+(\S+))?/);
  return m ? { percent: parseFloat(m[1]), total: m[2].trim(), speed: m[3].trim(), eta: m[4] || null } : null;
}

async function probeStreams(file) {
  const r = await run(BIN.ffprobe, ['-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name,width,height', '-of', 'json', file]);
  if (r.code !== 0) throw new Error(r.stderr || 'ffprobe indisponible.');
  const streams = JSON.parse(r.stdout).streams || [];
  return { video: streams.find((s) => s.codec_type === 'video') || null, audio: streams.find((s) => s.codec_type === 'audio') || null };
}

// ─── Sous-titres ─────────────────────────────────────────────────
// YouTube bloque désormais presque toujours ses sous-titres AUTO-TRADUITS
// (ex. « fr » sur une vidéo anglaise → HTTP 429), alors que les sous-titres
// dans la langue d'origine passent sans problème. Stratégie :
//   1. essayer la langue demandée (marche si la vidéo a de vrais sous-titres dans cette langue) ;
//   2. sinon récupérer les sous-titres d'origine et les traduire nous-mêmes ;
//   3. si la traduction échoue, garder les sous-titres d'origine plutôt que rien.
function pickSrt(dir, base, prefer) {
  const files = fs.readdirSync(dir).filter((n) => n.startsWith(base + '.') && n.toLowerCase().endsWith('.srt'));
  const ok = (n) => fs.statSync(path.join(dir, n)).size >= 32;
  const chosen = (prefer && (files.find((n) => n === `${base}.${prefer}.srt` && ok(n)) || files.find((n) => n.startsWith(`${base}.${prefer}-`) && ok(n))))
    || files.find(ok);
  return chosen ? { file: path.join(dir, chosen), lang: chosen.slice(base.length + 1, -4) } : null;
}

async function fetchSubs(url, langs, outBase, signal, auto = true) {
  await run(BIN.ytdlp, [
    '--skip-download', '--write-subs', ...(auto ? ['--write-auto-subs'] : []), '--sub-langs', langs,
    '--sub-format', 'srt/vtt/best', '--convert-subs', 'srt', '--ffmpeg-location', BIN.ffmpegDir,
    '-o', outBase, '--no-playlist', '--retries', '3', '--extractor-retries', '2', '--sleep-subtitles', '1',
    ...cookieArgs(), ...jsArgs(), '--user-agent', UA, url,
  ], { signal });
}

// Lecture / écriture SRT
function parseSrt(text) {
  return text.replace(/\r/g, '').trim().split(/\n{2,}/).map((block) => {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    return i < 0 ? null : { time: lines[i], text: lines.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').trim() };
  }).filter((c) => c && c.text);
}
const writeSrt = (cues) => cues.map((c, i) => `${i + 1}\n${c.time}\n${c.text}\n`).join('\n');

// Traduction via le service public de Google Traduction (sans clé), par paquets.
async function translateTexts(texts, target, signal) {
  const out = [];
  let batch = [], size = 0;
  const flush = async () => {
    if (!batch.length) return;
    const q = batch.join('\n');
    const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(q)}`, { signal });
    if (!res.ok) throw new Error(`traduction HTTP ${res.status}`);
    const data = await res.json();
    const lines = (data[0] || []).map((seg) => seg[0] || '').join('').split('\n').map((l) => l.trim());
    if (lines.length === batch.length) out.push(...lines);
    else {
      // Découpage différent : on traduit ligne par ligne pour rester aligné sur le minutage
      for (const t of batch) {
        const r = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(t)}`, { signal });
        const d = r.ok ? await r.json() : null;
        out.push(d ? (d[0] || []).map((seg) => seg[0] || '').join('').trim() : t);
      }
    }
    batch = []; size = 0;
  };
  for (const t of texts) {
    const clean = t.replace(/\n/g, ' ');
    if (size + clean.length > 1800 || batch.length >= 60) await flush();
    batch.push(clean); size += clean.length + 1;
  }
  await flush();
  return out;
}

async function getSubtitles(url, lang, work, signal) {
  const base = 'sub';
  const outBase = path.join(work, base);
  // 1. Langue demandée : vrais sous-titres, puis pistes automatiques
  await fetchSubs(url, `${lang},${lang}-.*`, outBase, signal, false);
  let got = pickSrt(work, base, lang);
  if (got && got.lang.split('-')[0] === lang) return { file: got.file, lang, mode: 'direct' };
  // 2. Sous-titres d'origine (pistes auto « -orig » ou manuelles), puis traduction
  if (!got) { await fetchSubs(url, '.*-orig', outBase, signal); got = pickSrt(work, base, null); }
  if (!got) { await fetchSubs(url, 'en,en-.*', outBase, signal); got = pickSrt(work, base, 'en'); }
  if (!got) return null;
  const srcLang = got.lang.replace(/-orig$/, '').split('-')[0];
  if (srcLang === lang) return { file: got.file, lang, mode: 'direct' };
  try {
    const cues = parseSrt(fs.readFileSync(got.file, 'utf8'));
    const translated = await translateTexts(cues.map((c) => c.text), lang, signal);
    const outFile = path.join(work, `translated.${lang}.srt`);
    fs.writeFileSync(outFile, writeSrt(cues.map((c, i) => ({ ...c, text: translated[i] || c.text }))), 'utf8');
    return { file: outFile, lang, mode: 'translated', from: srcLang };
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return { file: got.file, lang: srcLang, mode: 'original' }; // mieux que rien
  }
}

// Finalisation en une passe ffmpeg : H.264/AAC lisible partout, sous-titres en piste, +faststart.
async function finalizeVideo(file, targetHeight, subtitlePath, lang, signal) {
  const out = `${file}.final.mp4`;
  const { video, audio } = await probeStreams(file);
  const h = Number(video?.height) || 0;
  const needScale = h > 0 && h > targetHeight;
  const args = ['-y', '-i', file];
  if (subtitlePath) args.push('-i', subtitlePath, '-map', '0:v:0', '-map', '0:a:0?', '-map', '1:0');
  if (video?.codec_name === 'h264' && !needScale) args.push('-c:v', 'copy');
  else {
    if (needScale) args.push('-vf', `scale=-2:${targetHeight}`);
    args.push('-c:v', 'libx264', '-profile:v', 'high', '-level', '5.1', '-crf', '20', '-pix_fmt', 'yuv420p', '-preset', 'veryfast');
  }
  if (audio) args.push(...(audio.codec_name === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']));
  // Code langue sur 3 lettres (ISO 639-2) : les lecteurs affichent alors « Français », « English »…
  const ISO3 = { fr: 'fra', en: 'eng', es: 'spa', it: 'ita', de: 'deu', ar: 'ara', pt: 'por', ru: 'rus', ja: 'jpn', ko: 'kor', zh: 'zho', nl: 'nld', tr: 'tur', hi: 'hin' };
  if (subtitlePath) args.push('-c:s', 'mov_text', '-metadata:s:s:0', `language=${ISO3[lang] || lang || 'und'}`);
  args.push('-movflags', '+faststart', out);
  const r = await run(BIN.ffmpeg, args, { signal });
  if (r.code !== 0 || !fs.existsSync(out)) { try { fs.unlinkSync(out); } catch { } throw new Error('Conversion vidéo impossible : ' + r.stderr.slice(-300)); }
  await fsp.unlink(file);
  await fsp.rename(out, file);
}

/**
 * Télécharge un élément et renvoie le chemin du fichier temporaire final.
 * onEvent reçoit les mêmes messages que le flux SSE du serveur
 * ({type:'progress'|'processing', ...}).
 */
async function download(it, { signal, onEvent }) {
  const isAudio = it.quality === 'mp3';
  const targetHeight = HEIGHTS[it.quality] || 1080;
  const work = path.join(os.tmpdir(), 'StreamLoader', it.id);
  await fsp.mkdir(work, { recursive: true });
  const outBase = path.join(work, 'media');

  const args = [
    '-f', isAudio ? 'bestaudio/best' : videoSelector(targetHeight),
    '-o', `${outBase}.%(ext)s`,
    '--newline', '--progress', '--no-warnings', '--no-playlist', '--playlist-items', '1', '--no-mtime',
    '--no-part', '--ffmpeg-location', BIN.ffmpegDir,
    '--concurrent-fragments', '4', '--retries', '10', '--fragment-retries', '10',
  ];
  if (isAudio) args.push('--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0');
  else args.push('--merge-output-format', 'mp4');
  if (it.trim) args.push('--download-sections', `*${it.trim.start}-${it.trim.end}`, '--force-keyframes-at-cuts');
  args.push(...cookieArgs(), ...jsArgs(), '--user-agent', UA, it.url);

  // Progression monotone sur l'ensemble des flux (vidéo puis audio), comme sur le serveur.
  let expected = 1, index = 0, best = 0;
  const onLine = (line) => {
    const info = line.match(/Downloading (\d+) format\(s?\)(?::\s*(\S+))?/i);
    if (info) { expected = Math.max(1, parseInt(info[1], 10), ((info[2] || '').match(/\+/g) || []).length + 1); return; }
    if (/\[download\]\s+Destination:/i.test(line)) { index += 1; expected = Math.max(expected, index); return; }
    if (/^\[(Merger|ExtractAudio|FixupM3u8|VideoConvertor)\]/.test(line)) { onEvent({ type: 'processing' }); return; }
    const p = parseProgress(line);
    if (p) {
      const streams = Math.max(expected, index, 1), started = Math.max(index, 1);
      best = Math.max(best, Math.min(99, ((started - 1) + p.percent / 100) / streams * 100));
      onEvent({ type: 'progress', percent: best, speed: p.speed, eta: p.eta, total: p.total });
    }
  };

  let r;
  try { r = await run(BIN.ytdlp, args, { signal, onLine }); }
  catch (e) { await fsp.rm(work, { recursive: true, force: true }).catch(() => { }); throw e; }

  const produced = fs.readdirSync(work).filter((n) => n.startsWith('media.') && !/\.(part|ytdl|srt|vtt)$/i.test(n));
  const wanted = produced.find((n) => n.endsWith(isAudio ? '.mp3' : '.mp4')) || produced[0];
  if (r.code !== 0 || !wanted) {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => { });
    throw new Error(parseYtdlpError(r.stderr));
  }
  let file = path.join(work, wanted);

  onEvent({ type: 'processing' });
  let subs = null;
  try {
    if (!isAudio) {
      if (!file.endsWith('.mp4')) { const mp4 = `${outBase}.mp4`; await fsp.rename(file, mp4); file = mp4; }
      if (it.sublang) {
        try { subs = await getSubtitles(it.url, it.sublang, work, signal); }
        catch (e) { if (e.name === 'AbortError') throw e; subs = null; }
      }
      await finalizeVideo(file, targetHeight, subs?.file || null, subs?.lang || it.sublang, signal);
    }
  } catch (e) {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => { });
    throw e;
  }
  return { file, subs: subs ? { lang: subs.lang, mode: subs.mode, from: subs.from || null } : (it.sublang ? { lang: null, mode: 'none' } : null), cleanup: () => fsp.rm(work, { recursive: true, force: true }).catch(() => { }) };
}

module.exports = { init, analyze, download, update, version, setCookiesBrowser, getVersion: () => ytdlpVersion };
