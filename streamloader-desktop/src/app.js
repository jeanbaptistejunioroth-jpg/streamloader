// ─────────────────────────────────────────────────────────────────
//  StreamLoader Desktop — interface
// ─────────────────────────────────────────────────────────────────
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const FORMATS = [
  { key: 'mp3',   group: 'audio', label: 'MP3',  hint: '320 kbps' },
  { key: '360p',  group: 'video', label: 'MP4 360p' },
  { key: '480p',  group: 'video', label: 'MP4 480p' },
  { key: '720p',  group: 'video', label: 'MP4 720p',  hint: 'HD' },
  { key: '1080p', group: 'video', label: 'MP4 1080p', hint: 'Full HD' },
  { key: '1440p', group: 'video', label: 'MP4 2K',    hint: '1440p' },
  { key: '4k',    group: 'video', label: 'MP4 4K',    hint: '2160p' },
];
const fmtOf = (k) => FORMATS.find((f) => f.key === k) || FORMATS[4];
const ACTIVE = ['analyzing', 'waiting', 'queued', 'downloading', 'processing', 'saving'];

const state = {
  lang: 'fr',
  settings: null,
  session: null,
  items: [],
  view: 'home',
  format: '1080p',
  info: {},
  profile: { avatar: null, name: null },
};

// ─── Traduction ──────────────────────────────────────────────────
function t(key, vars = {}) {
  const dict = window.I18N[state.lang] || window.I18N.fr;
  let s = dict[key] ?? window.I18N.fr[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
}
function errText(code, message) {
  if (code && window.I18N.fr[`err.${code}`]) return t(`err.${code}`);
  if (message && window.I18N.fr[`err.${message}`]) return t(`err.${message}`);
  return message || t('err.generic');
}
function applyI18n() {
  document.documentElement.lang = state.lang;
  $$('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $$('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  $$('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); el.setAttribute('aria-label', el.title); });
  $('#langLabel').textContent = state.lang.toUpperCase();
}

// ─── Thème jour / nuit ───────────────────────────────────────────
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function currentDark() {
  const th = state.settings?.theme || 'system';
  return th === 'dark' || (th === 'system' && darkQuery.matches);
}
function applyTheme() {
  const dark = currentDark();
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#themeIcon use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
  $$('#setTheme button').forEach((b) => b.classList.toggle('on', b.dataset.v === (state.settings?.theme || 'system')));
}
darkQuery.addEventListener('change', applyTheme);

// ─── Petits utilitaires ──────────────────────────────────────────
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}
const icon = (id, cls) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  if (cls) s.setAttribute('class', cls);
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', `#${id}`);
  s.append(u);
  return s;
};
function fmtDuration(sec) {
  if (!sec && sec !== 0) return null;
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${p(h)}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}
function fmtSize(bytes) {
  if (!bytes) return null;
  const u = state.lang === 'fr' ? ['o', 'Ko', 'Mo', 'Go'] : ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i >= 2 ? 2 : 0).replace('.', state.lang === 'fr' ? ',' : '.')} ${u[i]}`;
}
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }

let toastTimer = 0;
function toast(msg, isErr = false) {
  const n = el('div', { class: `toast${isErr ? ' err' : ''}` }, msg);
  $('#toasts').append(n);
  setTimeout(() => { n.classList.add('out'); setTimeout(() => n.remove(), 300); }, isErr ? 5200 : 3000);
  clearTimeout(toastTimer);
}

async function call(promise) {
  const r = await promise;
  if (!r.ok) { const e = new Error(r.message); e.code = r.code; e.status = r.status; throw e; }
  return r.data;
}

// ─── Navigation ──────────────────────────────────────────────────
const LIST_VIEWS = { home: 'home.title', videos: 'videos.title', audio: 'audio.title', queue: 'queue.title' };

function showView(view) {
  state.view = view;
  const s = state.session;
  const locked = !s?.loggedIn || !s.isPremium;
  document.body.classList.toggle('locked', locked);

  $('#view-login').hidden = !(!s?.loggedIn);
  $('#view-gate').hidden = !(s?.loggedIn && !s.isPremium);
  const isList = !locked && view in LIST_VIEWS;
  $('#view-list').hidden = !isList;
  $('#view-settings').hidden = locked || view !== 'settings';
  $('#view-account').hidden = locked || view !== 'account';
  $('#topbar').hidden = !isList;

  $$('.side-btn[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#sideAvatar').classList.toggle('active', view === 'account');
  if (isList) {
    $('#listTitle').dataset.i18n = LIST_VIEWS[view];
    $('#listTitle').textContent = t(LIST_VIEWS[view]);
    renderList();
  }
  if (view === 'settings') renderSettings();
  if (view === 'account') renderAccount();
  if (locked) renderLocked();
}

// ─── Liste des téléchargements ───────────────────────────────────
function visibleItems() {
  const all = state.items;
  switch (state.view) {
    case 'videos': return all.filter((i) => i.ext === 'mp4');
    case 'audio': return all.filter((i) => i.ext === 'mp3');
    case 'queue': return all.filter((i) => ACTIVE.includes(i.status));
    default: return all;
  }
}

function statusPill(it) {
  const pct = Math.floor(it.percent || 0);
  switch (it.status) {
    case 'done': return el('span', { class: 'pill done' }, icon('i-check'), t('st.done'));
    case 'error': return el('span', { class: 'pill error' }, t('st.error'));
    case 'canceled': return el('span', { class: 'pill muted' }, t('st.canceled'));
    case 'analyzing': return el('span', { class: 'pill muted' }, t('st.analyzing'));
    case 'waiting': return el('span', { class: 'pill muted' }, t('st.waiting'));
    case 'queued': return el('span', { class: 'pill muted' }, it.queuePosition ? t('st.queuedPos', { n: it.queuePosition }) : t('st.queued'));
    case 'downloading': return el('span', { class: 'pill' }, `${t('st.downloading')} ${pct} %`);
    case 'processing': return el('span', { class: 'pill' }, t('st.processing'));
    case 'saving': return el('span', { class: 'pill' }, `${t('st.saving')} ${pct} %`);
    default: return el('span', { class: 'pill muted' }, it.status);
  }
}

function subLabel(it) {
  const r = it.subResult;
  if (!r || it.status !== 'done') return t('tag.subs', { l: it.sublang.toUpperCase() });
  if (r.mode === 'none') return t('tag.noSubs');
  return t('tag.subs', { l: (r.lang || it.sublang).toUpperCase() });
}
function subTitle(it) {
  const r = it.subResult;
  if (!r || it.status !== 'done') return '';
  if (r.mode === 'translated') return t('tag.subsTranslated', { f: (r.from || '?').toUpperCase(), l: r.lang.toUpperCase() });
  if (r.mode === 'original') return t('tag.subsOriginal', { l: (r.lang || '?').toUpperCase() });
  if (r.mode === 'none') return t('tag.noSubsHint');
  return '';
}

function card(it) {
  const f = fmtOf(it.quality);
  const isActive = ACTIVE.includes(it.status);
  const thumb = el('div', { class: 'thumb' },
    it.thumbnail ? el('img', { src: it.thumbnail, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e) => e.target.replaceWith(icon('i-film')) }) : icon('i-film'),
    it.duration ? el('span', { class: 'dur' }, fmtDuration(it.duration)) : null,
  );

  const metaBits = [];
  const who = it.uploader || hostOf(it.url);
  if (who) metaBits.push(el('span', { class: 'm' }, who));
  if (it.duration) metaBits.push(el('span', { class: 'm' }, icon('i-clock'), fmtDuration(it.duration)));
  if (it.sizeBytes) { metaBits.push(el('span', { class: 'bar-sep' })); metaBits.push(el('span', { class: 'm' }, fmtSize(it.sizeBytes))); }

  let extra = null;
  if (it.status === 'downloading' && (it.speed || it.eta)) extra = [it.speed, it.eta && `ETA ${it.eta}`].filter(Boolean).join(' · ');
  if (it.status === 'done' && it.finishedAt) extra = new Date(it.finishedAt).toLocaleString(state.lang === 'fr' ? 'fr-FR' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' });

  const showBar = isActive && it.status !== 'canceled';
  const indet = ['analyzing', 'waiting', 'queued', 'processing'].includes(it.status);

  const node = el('article', { class: `dl-card${it.status === 'done' ? ' is-done' : ''}`, 'data-id': it.id },
    thumb,
    el('div', { class: 'dl-body' },
      el('div', { class: `dl-title${it.title ? '' : ' muted'}`, title: it.title || it.url }, it.title || it.url),
      el('div', { class: 'dl-meta' }, metaBits),
      showBar ? el('div', { class: `bar${indet ? ' indet' : ''}` }, el('i', { style: `width:${Math.max(2, it.percent || 0)}%` })) : null,
      el('div', { class: 'dl-foot' },
        statusPill(it),
        el('span', { class: 'fmt-chip' }, el('span', { class: 'circ' }, icon(it.ext === 'mp3' ? 'i-music' : 'i-play')), it.ext === 'mp3' ? 'mp3' : `mp4 · ${f.label.replace('MP4 ', '')}`),
        (it.sublang || it.trim) ? el('span', { class: 'dl-tags' },
          it.sublang ? el('span', { class: `tag${it.subResult?.mode === 'none' || it.subResult?.mode === 'original' ? ' warn' : ''}`, title: subTitle(it) }, subLabel(it)) : null,
          it.trim ? el('span', { class: 'tag' }, `✂ ${it.trim.start} – ${it.trim.end}`) : null) : null,
        it.status === 'error' ? el('span', { class: 'dl-err', title: errText(it.error, it.error) }, errText(it.error, it.error)) : null,
        extra ? el('span', { class: 'dl-extra' }, extra) : null,
      ),
    ),
    el('button', { class: 'kebab', title: '…', onclick: (e) => { e.stopPropagation(); openCtx(it, e.currentTarget); } }, icon('i-dots')),
  );
  node.addEventListener('dblclick', () => { if (it.status === 'done') act(() => window.sl.downloads.open(it.id)); });
  node.addEventListener('contextmenu', (e) => { e.preventDefault(); openCtx(it, null, e.clientX, e.clientY); });
  return node;
}

let renderQueued = false;
function renderList() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if ($('#view-list').hidden) return;
    const list = $('#list');
    const items = visibleItems();
    // Mise à jour sans tout reconstruire si les cartes sont les mêmes (évite le clignotement)
    const ids = items.map((i) => i.id).join(',');
    if (list.dataset.ids === ids) {
      items.forEach((it, idx) => {
        const old = list.children[idx];
        const sig = JSON.stringify([it.subResult?.mode, it.status, Math.floor(it.percent), it.title, it.thumbnail, it.speed, it.eta, it.queuePosition, it.sizeBytes, it.error, state.lang]);
        if (old.dataset.sig !== sig) { const n = card(it); n.dataset.sig = sig; n.style.animation = 'none'; old.replaceWith(n); }
      });
    } else {
      list.replaceChildren(...items.map((it) => {
        const n = card(it);
        n.dataset.sig = JSON.stringify([it.subResult?.mode, it.status, Math.floor(it.percent), it.title, it.thumbnail, it.speed, it.eta, it.queuePosition, it.sizeBytes, it.error, state.lang]);
        return n;
      }));
      list.dataset.ids = ids;
      if (!items.length) {
        list.dataset.ids = '';
        if (state.items.length) list.append(el('p', { class: 'empty' }, t(state.view === 'queue' ? 'list.emptyQueue' : 'list.empty')));
      }
    }
    $('#clearBtn').hidden = !state.items.some((i) => !ACTIVE.includes(i.status));
    $('#dropzone').hidden = state.view === 'audio' || state.view === 'videos' ? items.length > 0 : false;
  });
  const running = state.items.filter((i) => ACTIVE.includes(i.status)).length;
  $('#queueBadge').hidden = !running;
  $('#queueBadge').textContent = running;
}

// ─── Menu contextuel d'un téléchargement ─────────────────────────
function closeMenus() { $('#ctxMenu').hidden = true; $('#fmtMenu').hidden = true; }
document.addEventListener('mousedown', (e) => { if (!e.target.closest('.menu, .fmt-btn, .kebab')) closeMenus(); });
window.addEventListener('blur', closeMenus);
window.addEventListener('resize', closeMenus);

async function act(fn, okMsg) {
  try { await call(fn()); if (okMsg) toast(okMsg); }
  catch (e) { toast(errText(e.code, e.message), true); }
}

function openCtx(it, anchor, x, y) {
  const m = $('#ctxMenu');
  const items = [];
  const add = (label, ic, fn, cls) => items.push(el('button', { class: `menu-item${cls ? ' ' + cls : ''}`, onclick: () => { closeMenus(); fn(); } }, icon(ic), label));
  const sep = () => items.push(el('div', { class: 'menu-sep' }));
  const S = window.sl.downloads;

  if (it.status === 'done') {
    add(t('menu.open'), 'i-play', () => act(() => S.open(it.id)));
    add(t('menu.reveal'), 'i-folder', () => act(() => S.reveal(it.id)));
  }
  if (['error', 'canceled'].includes(it.status)) add(t('menu.retry'), 'i-retry', () => act(() => S.retry(it.id)));
  if (ACTIVE.includes(it.status)) add(t('menu.cancel'), 'i-x', () => act(() => S.cancel(it.id)));
  add(t('menu.copy'), 'i-copy', () => act(() => window.sl.clipboard.write(it.url), t('toast.copied')));
  sep();
  add(t('menu.remove'), 'i-trash', () => act(() => S.remove(it.id, false)), 'danger');
  if (it.status === 'done' && it.filePath) {
    add(t('menu.delete'), 'i-trash', () => { if (confirm(t('confirm.delete'))) act(() => S.remove(it.id, true)); }, 'danger');
  }
  m.replaceChildren(...items);
  m.hidden = false;
  const r = anchor ? anchor.getBoundingClientRect() : { left: x, right: x, bottom: y, top: y };
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let left = anchor ? r.right - mw : x;
  let top = anchor ? r.bottom + 4 : y;
  left = Math.max(8, Math.min(left, innerWidth - mw - 8));
  if (top + mh > innerHeight - 8) top = Math.max(8, (anchor ? r.top - mh - 4 : y - mh));
  m.style.left = `${left}px`; m.style.top = `${top}px`;
}

// ─── Sélecteur de format ─────────────────────────────────────────
function renderFormatMenu() {
  const m = $('#fmtMenu');
  const rows = [];
  for (const g of ['audio', 'video']) {
    rows.push(el('div', { class: 'menu-group' }, t(`fmt.${g}`)));
    for (const f of FORMATS.filter((x) => x.group === g)) {
      rows.push(el('button', {
        type: 'button', class: `menu-item${f.key === state.format ? ' selected' : ''}`,
        onclick: () => { state.format = f.key; $('#fmtLabel').textContent = f.label; closeMenus(); $('#urlInput').focus(); },
      }, f.label, f.hint ? el('small', {}, f.hint) : null));
    }
  }
  m.replaceChildren(...rows);
}
$('#fmtBtn').addEventListener('click', () => {
  const m = $('#fmtMenu');
  if (!m.hidden) return closeMenus();
  closeMenus(); renderFormatMenu(); m.hidden = false;
});
function setFormat(k) { state.format = fmtOf(k).key; $('#fmtLabel').textContent = fmtOf(k).label; }

// ─── Ajout d'un lien : analyse puis fiche d'options ──────────────
const Q_HEIGHT = { '4k': 2160, '1440p': 1440, '1080p': 1080, '720p': 720, '480p': 480, '360p': 360 };
const TRIM_RE = /^\d{1,2}(:\d{2}){1,2}$/;
const toSec = (v) => v.split(':').map(Number).reduce((a, n) => a * 60 + n, 0);
const sheet = { mode: null, data: null, quality: '1080p', selected: new Set() };

let adding = false;
async function addLink(raw) {
  const text = String(raw || '').trim();
  if (!text) { toast(t('err.EMPTY'), true); return; }
  if (adding) return;
  adding = true;
  const btn = $('#okBtn');
  btn.disabled = true;
  btn.replaceChildren(el('span', { class: 'spinner' }));
  try {
    const a = await call(window.sl.downloads.analyze(text));
    openSheet(a);
  } catch (e) {
    toast(errText(e.code, e.message), true);
  } finally {
    adding = false;
    btn.disabled = false;
    btn.replaceChildren(el('span', {}, t('search.ok')));
  }
}

function availableQualities(heights) {
  // Pour une vidéo verticale (TikTok…), la « hauteur » est le grand côté : on garde la règle du serveur.
  const max = heights?.length ? heights[0] : 0;
  const keys = Object.keys(Q_HEIGHT).filter((k) => !max || Q_HEIGHT[k] <= Math.max(max, 360));
  return ['mp3', ...keys];
}

function renderQualityCards(keys) {
  if (!keys.includes(sheet.quality)) {
    const want = Q_HEIGHT[state.format] || 1080;
    sheet.quality = state.format === 'mp3' ? 'mp3' : (keys.find((k) => k !== 'mp3' && Q_HEIGHT[k] <= want) || keys[keys.length - 1]);
  }
  $('#qGrid').replaceChildren(...keys.map((k) => el('button', {
    type: 'button', class: `q-card${k === sheet.quality ? ' sel' : ''}`,
    onclick: () => { sheet.quality = k; renderQualityCards(keys); syncSheet(); },
  }, el('b', {}, t(`q.${k}`)), el('small', {}, t(`q.${k}s`)))));
}

function syncSheet() {
  const audio = sheet.quality === 'mp3';
  $('#subSec').hidden = audio;
  $('#subOpts').hidden = !$('#subToggle').checked;
  $('#trimSec').hidden = sheet.mode !== 'video';
  $('#trimOpts').hidden = !$('#trimToggle').checked;
  if (sheet.mode === 'playlist') {
    const n = sheet.selected.size;
    $('#sheetGoTxt').textContent = t('sheet.goN', { n });
    $('#plAll').checked = n === sheet.data.entries.length;
    const notes = [t('sheet.plNote', { n, t: sheet.data.entries.length })];
    if (sheet.data.unavailable) notes.push(t('sheet.plUnavail', { n: sheet.data.unavailable }));
    $('#plNote').textContent = notes.join(' ');
  } else {
    $('#sheetGoTxt').textContent = t('sheet.go');
  }
}

function openSheet(a) {
  closeMenus();
  sheet.mode = a.kind;
  sheet.url = a.url;
  sheet.quality = state.format;
  $('#sheetErr').hidden = true;
  $('#subToggle').checked = false;
  $('#trimToggle').checked = false;
  $('#trimStart').value = ''; $('#trimEnd').value = '';
  $('#subLang').value = state.lang === 'fr' ? 'fr' : 'en';

  const thumbBox = $('#shThumb');
  if (a.kind === 'playlist') {
    const pl = a.playlist;
    sheet.data = pl;
    sheet.selected = new Set(pl.entries.map((_, i) => i));
    thumbBox.replaceChildren(icon('i-queue'));
    $('#shKicker').textContent = t('sheet.playlist', { n: pl.entries.length });
    $('#shTitle').textContent = pl.title;
    $('#shMeta').replaceChildren(...[pl.uploader, hostOf(pl.webpage || a.url)].filter(Boolean).map((x) => el('span', { class: 'm' }, x)));
    $('#plSec').hidden = false;
    $('#plList').replaceChildren(...pl.entries.map((e, i) => {
      const cb = el('input', { type: 'checkbox', checked: true, onchange: (ev) => { ev.target.checked ? sheet.selected.add(i) : sheet.selected.delete(i); syncSheet(); } });
      return el('label', { class: 'pl-item' }, cb, el('span', { class: 'idx' }, i + 1), el('span', { class: 'tt', title: e.title }, e.title), e.duration ? el('span', { class: 'dd' }, fmtDuration(e.duration)) : null);
    }));
    renderQualityCards(['mp3', ...Object.keys(Q_HEIGHT)]);
  } else {
    const d = a.data;
    sheet.data = d;
    thumbBox.replaceChildren(
      d.thumbnail ? el('img', { src: d.thumbnail, alt: '', referrerpolicy: 'no-referrer', onerror: (e) => e.target.replaceWith(icon('i-film')) }) : icon('i-film'),
      d.duration ? el('span', { class: 'dur' }, fmtDuration(d.duration)) : null,
    );
    $('#shKicker').textContent = d.extractor && d.extractor !== '?' ? d.extractor : t('sheet.video');
    $('#shTitle').textContent = d.title;
    const meta = [el('span', { class: 'm' }, d.uploader || hostOf(a.url))];
    if (d.duration) meta.push(el('span', { class: 'm' }, icon('i-clock'), fmtDuration(d.duration)));
    $('#shMeta').replaceChildren(...meta);
    $('#plSec').hidden = true;
    renderQualityCards(availableQualities(d.heights));
  }
  syncSheet();
  $('#sheetBg').hidden = false;
  setTimeout(() => $('#sheetGo').focus(), 30);
}
function closeSheet() { $('#sheetBg').hidden = true; sheet.mode = null; }

async function confirmSheet() {
  const err = $('#sheetErr');
  err.hidden = true;
  const fail = (code) => { err.textContent = errText(code); err.hidden = false; };
  const sublang = sheet.quality !== 'mp3' && $('#subToggle').checked ? $('#subLang').value : null;
  const go = $('#sheetGo');
  try {
    if (sheet.mode === 'playlist') {
      const entries = sheet.data.entries.filter((_, i) => sheet.selected.has(i));
      if (!entries.length) return fail('EMPTY_SELECTION');
      go.disabled = true;
      const r = await call(window.sl.downloads.enqueuePlaylist({
        webpage: sheet.data.webpage || sheet.url, title: sheet.data.title, uploader: sheet.data.uploader,
        entries, quality: sheet.quality, sublang,
      }));
      toast(t('toast.playlist', { t: r.title, n: r.count }));
    } else {
      let trim = null;
      if ($('#trimToggle').checked) {
        const start = $('#trimStart').value.trim(), endT = $('#trimEnd').value.trim();
        if (!TRIM_RE.test(start) || !TRIM_RE.test(endT) || toSec(endT) <= toSec(start)) return fail('INVALID_TRIM_TIME');
        if (sheet.data.duration && toSec(endT) > Math.ceil(sheet.data.duration)) return fail('TRIM_TOO_LONG');
        trim = { start, end: endT };
      }
      go.disabled = true;
      const d = sheet.data;
      await call(window.sl.downloads.enqueue({
        url: sheet.url, quality: sheet.quality, title: d.title, thumbnail: d.thumbnail,
        uploader: d.uploader, duration: d.duration, sublang, trim,
      }));
    }
    $('#urlInput').value = '';
    closeSheet();
    const q = sheet.quality;
    if (!(state.view in LIST_VIEWS) || (state.view === 'audio' && q !== 'mp3') || (state.view === 'videos' && q === 'mp3')) showView('home');
  } catch (e) {
    fail(e.code || e.message);
  } finally {
    go.disabled = false;
  }
}
$('#sheetGo').addEventListener('click', confirmSheet);
$('#sheetCancel').addEventListener('click', closeSheet);
$('#sheetClose').addEventListener('click', closeSheet);
$('#sheetBg').addEventListener('mousedown', (e) => { if (e.target.id === 'sheetBg') closeSheet(); });
$('#subToggle').addEventListener('change', syncSheet);
$('#trimToggle').addEventListener('change', () => { syncSheet(); if ($('#trimToggle').checked) $('#trimStart').focus(); });
$('#plAll').addEventListener('change', (e) => {
  sheet.selected = e.target.checked ? new Set(sheet.data.entries.map((_, i) => i)) : new Set();
  $$('#plList input').forEach((cb) => { cb.checked = e.target.checked; });
  syncSheet();
});
['#trimStart', '#trimEnd'].forEach((id) => $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmSheet(); }));

$('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); addLink($('#urlInput').value); });

// CTRL + V hors du champ : colle et lance directement
document.addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') { closeMenus(); if (!$('#sheetBg').hidden) closeSheet(); }
  const inField = e.target.closest('input, select, textarea');
  if (inField || !(e.ctrlKey && e.key.toLowerCase() === 'v')) return;
  if (document.body.classList.contains('locked') || !$('#sheetBg').hidden) return;
  e.preventDefault();
  const text = await window.sl.clipboard.read();
  if (text?.ok && text.data) { $('#urlInput').value = text.data.trim(); addLink(text.data); }
});

// Glisser-déposer d'un lien
let dragDepth = 0;
const hasLink = (dt) => dt && [...dt.types].some((x) => x === 'text/uri-list' || x === 'text/plain');
window.addEventListener('dragenter', (e) => {
  if (document.body.classList.contains('locked') || !hasLink(e.dataTransfer)) return;
  dragDepth++; $('#dropOverlay').hidden = false;
});
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0; $('#dropOverlay').hidden = true;
  if (document.body.classList.contains('locked')) return;
  const dt = e.dataTransfer;
  const text = (dt.getData('text/uri-list') || dt.getData('text/plain') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
  if (text) { if (!(state.view in LIST_VIEWS)) showView('home'); $('#urlInput').value = text.trim(); addLink(text); }
});

$('#clearBtn').addEventListener('click', () => { if (confirm(t('confirm.clear'))) act(() => window.sl.downloads.clear()); });

// ─── Réglages ────────────────────────────────────────────────────
function renderSettings() {
  const s = state.settings;
  if (!s) return;
  $('#setFolder').textContent = s.downloadDir;
  const sel = $('#setFormat');
  if (!sel.options.length) FORMATS.forEach((f) => sel.append(el('option', { value: f.key }, f.label + (f.hint ? ` (${f.hint})` : ''))));
  sel.value = s.defaultFormat;
  $('#setAuto').checked = s.autoDownload;
  $('#autoLbl').textContent = t(s.autoDownload ? 'settings.on' : 'settings.off');
  $('#setNotif').checked = s.notifications;
  $('#notifLbl').textContent = t(s.notifications ? 'settings.on' : 'settings.off');
  $('#setConcurrent').value = String(s.maxConcurrent);
  $('#setLang').value = s.language;
  if (document.activeElement !== $('#setServer')) $('#setServer').value = s.serverUrl;
  $('#versionTxt').textContent = t(isLocal() ? 'settings.versionLocal' : 'settings.version', { v: state.info.version || '' });
  const local = isLocal();
  $('#rowEngine').hidden = !local;
  $('#rowCookies').hidden = !local;
  $('#setCookies').value = state.settings.cookiesBrowser || 'none';
  $('#engineTxt').textContent = t('settings.engineSub', { v: state.info.engine || '…' });
  $('#subLink').hidden = local;
  $('#rowServer').hidden = local;
  $('#logoutBtn2').hidden = local;
  applyTheme();
}
async function saveSetting(patch, msg) {
  try {
    state.settings = await call(window.sl.settings.set(patch));
    onSettings(state.settings);
    if (msg) toast(msg);
  } catch (e) { toast(errText(e.code, e.message), true); renderSettings(); }
}
$('#browseBtn').addEventListener('click', async () => { try { onSettings(await call(window.sl.settings.chooseFolder())); } catch (e) { toast(errText(e.code, e.message), true); } });
$('#openFolderBtn').addEventListener('click', () => act(() => window.sl.settings.openFolder()));
$('#setFormat').addEventListener('change', (e) => { saveSetting({ defaultFormat: e.target.value }); setFormat(e.target.value); });
$('#setAuto').addEventListener('change', (e) => saveSetting({ autoDownload: e.target.checked }));
$('#setNotif').addEventListener('change', (e) => saveSetting({ notifications: e.target.checked }));
$('#setConcurrent').addEventListener('change', (e) => saveSetting({ maxConcurrent: Number(e.target.value) }));
$('#setCookies').addEventListener('change', (e) => saveSetting({ cookiesBrowser: e.target.value }, t('toast.saved')));
$('#setLang').addEventListener('change', (e) => saveSetting({ language: e.target.value }));
$$('#setTheme button').forEach((b) => b.addEventListener('click', () => saveSetting({ theme: b.dataset.v })));
$('#serverForm').addEventListener('submit', (e) => { e.preventDefault(); saveSetting({ serverUrl: $('#setServer').value }, t('toast.saved')).then(refreshSession); });
$('#subLink').addEventListener('click', () => window.sl.openSite());
$('#engineBtn').addEventListener('click', async () => {
  const b = $('#engineBtn'); b.disabled = true; b.textContent = t('settings.engineUpdating');
  try {
    const r = await call(window.sl.engine.update());
    state.info.engine = r?.version || state.info.engine;
    toast(t('settings.engineDone', { v: state.info.engine || '?' }));
  } catch (e) { toast(errText(e.code, e.message), true); }
  b.disabled = false; b.textContent = t('settings.engineUpdate'); renderSettings();
});

// Boutons rapides de la barre de titre
$('#langBtn').addEventListener('click', () => saveSetting({ language: state.lang === 'fr' ? 'en' : 'fr' }));
$('#themeBtn').addEventListener('click', () => saveSetting({ theme: currentDark() ? 'light' : 'dark' }));

function onSettings(s) {
  state.settings = s;
  const langChanged = state.lang !== s.language;
  state.lang = s.language;
  applyTheme();
  if (langChanged) { applyI18n(); renderList(); showView(state.view); }
  if (state.view === 'settings') renderSettings();
}

// ─── Compte ──────────────────────────────────────────────────────
function untilText(s) {
  if (!s.premiumUntil) return t('account.noEnd');
  const d = new Date(s.premiumUntil).toLocaleDateString(state.lang === 'fr' ? 'fr-FR' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return t('account.until', { d });
}
const isLocal = () => state.info.mode === 'local';

function setAvatar(box, letter) {
  const src = state.profile?.avatar;
  if (src) box.replaceChildren(el('img', { src, alt: '' }));
  else box.replaceChildren(document.createTextNode((letter || '?').toUpperCase()));
}
function displayName() {
  const s = state.session;
  if (isLocal()) return state.profile?.name || (state.lang === 'fr' ? 'Moi' : 'Me');
  const e = s?.email || '';
  const n = e.split('@')[0].replace(/[._-]+/g, ' ').trim();
  return n ? n.replace(/\b\w/g, (c) => c.toUpperCase()) : e;
}
function renderProfileBits() {
  const name = displayName();
  setAvatar($('#sideAvatarImg'), name[0]);
  setAvatar($('#accAvatar'), name[0]);
  $('#photoRemove').hidden = !state.profile?.avatar;
}
function renderAccount() {
  const s = state.session;
  if (!s?.loggedIn) return;
  const local = isLocal();
  renderProfileBits();
  $('#accName').textContent = displayName();
  $('#accBadge').textContent = local ? t('acc.localBadge') : 'Premium';
  $('#accEmail').textContent = local ? t('acc.localSub', { v: state.info.engine || '—' }) : s.email;
  $('#accPlan').textContent = local ? t('acc.planLocal') : 'Premium';
  $('#accUntil').textContent = local || !s.premiumUntil ? t('acc.unlimited')
    : new Date(s.premiumUntil).toLocaleDateString(state.lang === 'fr' ? 'fr-FR' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  $('#accStatus').textContent = t('acc.active');
  $('#accCount').textContent = String(state.items.filter((i) => i.status === 'done').length);
  $('#accOffline').hidden = !s.offline;
  $('#nameForm').hidden = !local;
  if (local && document.activeElement !== $('#nameInput')) $('#nameInput').value = state.profile?.name || '';
  $('#accActions').hidden = local;
  $('#apiBox').hidden = local;
  if (!local) loadApiKey();
}
async function choosePhoto() {
  try { state.profile = await call(window.sl.profile.choosePhoto()); renderProfileBits(); }
  catch (e) { toast(errText(e.code, e.message), true); }
}
$('#photoBtn').addEventListener('click', choosePhoto);
$('#photoChange').addEventListener('click', choosePhoto);
$('#photoRemove').addEventListener('click', async () => {
  state.profile = await call(window.sl.profile.removePhoto()); renderProfileBits();
});
$('#nameForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  state.profile = await call(window.sl.profile.setName($('#nameInput').value));
  renderAccount(); toast(t('toast.saved'));
});
$('#sideAvatar').addEventListener('click', () => showView('account'));
$('#manageBtn').addEventListener('click', () => window.sl.openSite());
$('#checkBtn').addEventListener('click', async () => { await refreshSession(); if (state.session?.isPremium) toast(untilText(state.session)); });
$('#createLink').addEventListener('click', () => window.sl.openSite('/'));
$('#eyeBtn').addEventListener('click', () => {
  const inp = $('#loginPass'); const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  $('#eyeBtn use').setAttribute('href', show ? '#i-eyeoff' : '#i-eye');
});


// ─── Clé API Premium ─────────────────────────────────────────────
const apiState = { key: null, visible: false };
function renderApiKey(d) {
  $('#apiLoading').hidden = true;
  $('#apiNoKey').hidden = d.hasKey;
  $('#apiHasKey').hidden = !d.hasKey;
  if (!d.hasKey) return;
  apiState.key = d.apiKey || null;
  const txt = apiState.key ? (apiState.visible ? apiState.key : apiState.key.slice(0, 12) + '•'.repeat(24)) : `${d.prefix || ''}…`;
  $('#apiKeyTxt').textContent = txt;
  $('#apiShowBtn').hidden = $('#apiCopyBtn').hidden = !apiState.key;
  $('#apiShowBtn').textContent = t(apiState.visible ? 'api.hide' : 'api.show');
  $('#apiLegacy').hidden = Boolean(apiState.key);
  $('#apiDate').textContent = d.createdAt ? t('api.created', { d: new Date(String(d.createdAt).replace(' ', 'T') + 'Z').toLocaleDateString(state.lang === 'fr' ? 'fr-FR' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) }) : '';
}
let apiLast = null;
async function loadApiKey() {
  $('#apiLoading').hidden = false;
  try { apiLast = await call(window.sl.apiKey.get()); renderApiKey(apiLast); }
  catch (e) { $('#apiLoading').textContent = errText(e.code, e.message); }
}
async function generateKey(confirmMsg) {
  if (confirmMsg && !confirm(confirmMsg)) return;
  try { await call(window.sl.apiKey.generate()); apiState.visible = true; await loadApiKey(); }
  catch (e) { toast(errText(e.code, e.message), true); }
}
$('#apiGenBtn').addEventListener('click', () => generateKey());
$('#apiRegenBtn').addEventListener('click', () => generateKey(t('api.confirmRegen')));
$('#apiRevokeBtn').addEventListener('click', async () => {
  if (!confirm(t('api.confirmRevoke'))) return;
  try { await call(window.sl.apiKey.revoke()); apiState.key = null; await loadApiKey(); }
  catch (e) { toast(errText(e.code, e.message), true); }
});
$('#apiShowBtn').addEventListener('click', () => { apiState.visible = !apiState.visible; if (apiLast) renderApiKey(apiLast); });
$('#apiCopyBtn').addEventListener('click', () => { if (apiState.key) act(() => window.sl.clipboard.write(apiState.key), t('api.copied')); });

// ─── Connexion / accès Premium ───────────────────────────────────
function renderLocked() {
  const s = state.session;
  if (s?.loggedIn && !s.isPremium) $('#gateEmail').textContent = s.email;
  if (!s?.loggedIn) setTimeout(() => $('#loginEmail').focus(), 50);
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#loginEmail').value.trim();
  const pass = $('#loginPass').value;
  const err = $('#loginErr');
  err.hidden = true;
  if (!email || !pass) { err.textContent = t('err.fields'); err.hidden = false; return; }
  const btn = $('#loginBtn');
  btn.disabled = true; btn.replaceChildren(el('span', { class: 'spinner' }));
  try {
    const s = await call(window.sl.session.login(email, pass));
    $('#loginPass').value = '';
    onSession(s);
  } catch (ex) {
    err.textContent = errText(ex.code, ex.message); err.hidden = false;
  } finally {
    btn.disabled = false; btn.replaceChildren(el('span', {}, t('login.submit')));
  }
});
$('#discoverLink').addEventListener('click', (e) => { e.preventDefault(); window.sl.openSite(); });
$('#upgradeBtn').addEventListener('click', () => window.sl.openSite());
$('#recheckBtn').addEventListener('click', async () => {
  const btn = $('#recheckBtn');
  btn.disabled = true;
  const s = await refreshSession();
  btn.disabled = false;
  if (s && !s.isPremium) { $('#gateErr').textContent = s.offline ? t('err.NETWORK') : t('gate.stillFree'); $('#gateErr').hidden = false; }
});
const doLogout = () => act(() => window.sl.session.logout());
['#logoutBtn', '#logoutBtn2', '#logoutBtn3', '#gateLogout'].forEach((id) => $(id).addEventListener('click', doLogout));

async function refreshSession() {
  try { const s = await call(window.sl.session.refresh()); onSession(s); return s; }
  catch { return state.session; }
}
function onSession(s) {
  setTimeout(renderProfileBits, 0);
  const wasLocked = !state.session?.loggedIn || !state.session.isPremium;
  state.session = s;
  $('#gateErr').hidden = true;
  const locked = !s.loggedIn || !s.isPremium;
  showView(locked ? state.view : (wasLocked ? 'home' : state.view));
}

// ─── Fenêtre ─────────────────────────────────────────────────────
$('#winMin').addEventListener('click', () => window.sl.win.minimize());
$('#winMax').addEventListener('click', () => window.sl.win.toggleMaximize());
$('#winClose').addEventListener('click', () => window.sl.win.close());
document.querySelector('.titlebar').addEventListener('dblclick', (e) => { if (!e.target.closest('button')) window.sl.win.toggleMaximize(); });
$$('.side-btn[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

// ─── Démarrage ───────────────────────────────────────────────────
(async function boot() {
  state.info = (await window.sl.info()).data || {};
  const settings = (await window.sl.settings.get()).data;
  state.settings = settings;
  state.lang = settings.language;
  setFormat(settings.defaultFormat);
  applyTheme();
  applyI18n();
  state.items = (await window.sl.downloads.list()).data || [];
  state.session = (await window.sl.session.get()).data;
  state.profile = (await window.sl.profile.get()).data || state.profile;
  if (isLocal()) { $('#logoutBtn').hidden = true; document.body.classList.add('mode-local'); }
  renderProfileBits();
  showView('home');
  document.body.classList.remove('booting');

  window.sl.downloads.onChange((items) => { state.items = items; renderList(); });
  window.sl.session.onChange(onSession);
  window.sl.settings.onChange(onSettings);
  window.sl.onTheme(applyTheme);
  window.sl.onToast((p) => toast(t(p.key, p.vars || {})));
  window.sl.profile.onChange((p) => { state.profile = p; renderProfileBits(); if (state.view === 'account') renderAccount(); });
  window.sl.engine.onChange((v) => { state.info.engine = v || state.info.engine; if (state.view === 'settings') renderSettings(); if (state.view === 'account') renderAccount(); });
})();
