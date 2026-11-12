'use strict';
// Test complet du flux de téléchargement avec log de TOUS les events SSE.
const http = require('http');

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

const URL_TO_TEST = process.argv[2] || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const SUBLANG = process.argv[3] || null;
const QUALITY = process.argv[4] || '720p';

(async () => {
  const t0 = Date.now();
  const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
  try {
    const payload = { url: URL_TO_TEST, quality: QUALITY, title: 'test720' };
    if (SUBLANG) payload.sublang = SUBLANG;
    console.log('[' + elapsed() + '] POST /api/download/start', JSON.stringify(payload));
    const resp = await post('http://localhost:3000/api/download/start', payload);
    console.log('[' + elapsed() + '] HTTP', resp.status, resp.body);
    const job = JSON.parse(resp.body);
    if (!job.jobId) { console.log('PAS DE jobId — abort'); return; }
    console.log('JOB_ID:', job.jobId);

    const timer = setTimeout(() => { console.log('[' + elapsed() + '] TIMEOUT'); process.exit(2); }, 180000);
    const req = http.get(`http://localhost:3000/api/progress/${job.jobId}`, res => {
      let buf = '';
      res.on('data', c => {
        buf += c.toString();
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const part of parts) {
          const line = part.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          const evt = JSON.parse(line.slice(6));
          console.log('[' + elapsed() + '] EVT', JSON.stringify(evt));
          if (evt.type === 'done') { clearTimeout(timer); console.log('OK DONE'); process.exit(0); }
          if (evt.type === 'error') { clearTimeout(timer); console.log('OK ERROR'); process.exit(1); }
        }
      });
      res.on('end', () => { console.log('[' + elapsed() + '] STREAM_END'); clearTimeout(timer); process.exit(0); });
    });
    req.on('error', e => { console.log('SSE err:', e.message); clearTimeout(timer); process.exit(1); });
  } catch (e) { console.log('ERR:', e.message); }
})();
