'use strict';
// Isolation du pipeline de conversion pour trouver le blocage.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const TMP_DIR = path.join(__dirname, 'tmp');
// Prend un fichier .mp4 existant dans tmp (pas un .converted.mp4)
const filepath = path.join(TMP_DIR, '48cc7f03-65a1-49e4-826d-7245bd1d4e62.mp4');
const targetHeight = 720;

console.log('[trace] filepath =', filepath);
console.log('[trace] exists =', fs.existsSync(filepath));

function probeVideo(fp) {
  return new Promise((resolve, reject) => {
    console.log('[probeVideo] spawn ffprobe');
    const probe = spawn('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,codec_name,profile',
      '-of', 'json', fp,
    ]);
    let stdout = '', stderr = '';
    probe.stdout.on('data', c => { stdout += c.toString(); });
    probe.stderr.on('data', c => { stderr += c.toString(); });
    probe.on('error', (e) => { console.log('[probeVideo] error', e.message); reject(e); });
    probe.on('close', code => {
      console.log('[probeVideo] close code=', code);
      if (code !== 0) return reject(new Error(stderr || 'ffprobe indisponible.'));
      try {
        const stream = JSON.parse(stdout).streams?.[0];
        if (!stream) throw new Error('Flux vidéo introuvable.');
        resolve(stream);
      } catch (error) { reject(error); }
    });
  });
}

function hasSubtitleStream(fp) {
  return new Promise((resolve) => {
    console.log('[hasSubtitleStream] spawn ffprobe');
    const probe = spawn('ffprobe', [
      '-v', 'error', '-select_streams', 's',
      '-show_entries', 'stream=index',
      '-of', 'csv=p=0', fp,
    ]);
    let stdout = '';
    probe.stdout.on('data', d => { stdout += d; });
    probe.on('close', () => { console.log('[hasSubtitleStream] close'); resolve(stdout.trim().length > 0); });
    probe.on('error', () => { console.log('[hasSubtitleStream] error'); resolve(false); });
  });
}

function transcodeVideo(fp, th) {
  return new Promise((resolve, reject) => {
    const convertedPath = `${fp}.converted.mp4`;
    console.log('[transcode] starting, convertedPath =', convertedPath);
    Promise.all([probeVideo(fp), hasSubtitleStream(fp)]).then(([stream, hasSubs]) => {
      console.log('[transcode] probe done. stream=', JSON.stringify(stream), 'hasSubs=', hasSubs);
      const sourceHeight = Number(stream.height);
      const canCopy = stream.codec_name === 'h264' && sourceHeight <= th;
      const videoArgs = canCopy
        ? ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k']
        : ['-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-c:a', 'aac', '-b:a', '192k'];
      console.log('[transcode] canCopy =', canCopy, 'args =', videoArgs.join(' '));
      const ffmpegArgs = ['-y', '-i', fp];
      ffmpegArgs.push(...videoArgs, '-movflags', '+faststart', convertedPath);
      console.log('[transcode] spawn ffmpeg');
      const ffmpeg = spawn('ffmpeg', ffmpegArgs);
      let stderr = '';
      ffmpeg.stderr.on('data', chunk => { stderr += chunk.toString(); });
      ffmpeg.on('error', (e) => { console.log('[transcode] ffmpeg error', e.message); reject(e); });
      ffmpeg.on('close', code => {
        console.log('[transcode] ffmpeg close code=', code, 'exists=', fs.existsSync(convertedPath));
        if (code !== 0 || !fs.existsSync(convertedPath)) {
          try { fs.unlinkSync(convertedPath); } catch { }
          return reject(new Error(stderr.slice(-500)));
        }
        resolve();
      });
    }).catch(reject);
  });
}

const t0 = Date.now();
transcodeVideo(filepath, targetHeight)
  .then(() => console.log('[trace] SUCCESS in', (Date.now() - t0) / 1000, 's'))
  .catch(e => console.log('[trace] FAILED in', (Date.now() - t0) / 1000, 's :', e.message));
