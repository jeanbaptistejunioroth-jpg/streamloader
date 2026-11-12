// ─────────────────────────────────────────────────────────────────
//  Construit les deux installeurs StreamLoader :
//    node build.js server  → StreamLoader-Setup-x.y.z.exe        (clients Premium, via le serveur)
//    node build.js local   → StreamLoader-Local-Setup-x.y.z.exe  (usage perso, yt-dlp + ffmpeg sur le PC)
//    node build.js all     → les deux
// ─────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const builder = require('electron-builder');

const ROOT = __dirname;
const pkg = require('./package.json');
const BASE_CONFIG = {
  serverUrl: 'https://back.streamloaders.net',
  siteUrl: 'https://streamloaders.net',
  premiumPath: '/#pricing',
  routes: {
    analyze: '/api/media/analyze',
    downloadStart: '/api/media/download/start',
    progress: '/api/media/progress/',
    file: '/api/media/file/',
    playlistStart: '/api/playlist/start',
  },
};

const VARIANTS = {
  server: {
    config: { ...BASE_CONFIG, mode: 'server' },
    productName: 'StreamLoader',
    appId: 'app.streamloader.desktop',
    artifact: 'StreamLoader-Setup-${version}.${ext}',
    sidebar: 'build/installerSidebar.bmp',
    welcome: "Cet assistant va installer StreamLoader sur ton ordinateur.$\\r$\\n$\\r$\\nStreamLoader pour Windows est réservé aux abonnés Premium : tu te connecteras avec ton compte du site streamloaders.net.$\\r$\\n$\\r$\\nClique sur Suivant pour continuer.",
    extraResources: [],
  },
  local: {
    config: { ...BASE_CONFIG, mode: 'local' },
    productName: 'StreamLoader Local',
    appId: 'app.streamloader.local',
    artifact: 'StreamLoader-Local-Setup-${version}.${ext}',
    sidebar: 'build/installerSidebar-local.bmp',
    welcome: "Cet assistant va installer StreamLoader Local sur ton ordinateur.$\\r$\\n$\\r$\\nCette version personnelle télécharge directement sur ce PC (yt-dlp et ffmpeg inclus), sans compte et sans limite.$\\r$\\n$\\r$\\nClique sur Suivant pour continuer.",
    extraResources: [{ from: 'vendor', to: 'bin', filter: ['**/*'] }],
  },
};

function installerScript(v) {
  const tpl = fs.readFileSync(path.join(ROOT, 'build', 'installer.template.nsh'), 'utf8');
  return tpl.replace('%%TITLE%%', `Bienvenue dans l'installation de ${v.productName}`).replace('%%WELCOME%%', v.welcome);
}

async function buildVariant(name) {
  const v = VARIANTS[name];
  if (name === 'local') {
    for (const f of ['vendor/yt-dlp.exe', 'vendor/ffmpeg/ffmpeg.exe', 'vendor/ffmpeg/ffprobe.exe']) {
      if (!fs.existsSync(path.join(ROOT, f))) throw new Error(`Fichier manquant pour la version locale : ${f}`);
    }
  }
  fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(v.config, null, 2));
  fs.writeFileSync(path.join(ROOT, 'build', 'installer.nsh'), installerScript(v));

  const base = pkg.build;
  const out = path.join('dist', name);
  console.log(`\n=== Construction : ${v.productName} ===`);
  await builder.build({
    targets: builder.Platform.WINDOWS.createTarget('nsis', builder.Arch.x64),
    config: {
      ...base,
      productName: v.productName,
      appId: v.appId,
      directories: { ...base.directories, output: out },
      extraResources: v.extraResources,
      win: { ...base.win, artifactName: v.artifact },
      nsis: {
        ...base.nsis,
        shortcutName: v.productName,
        uninstallDisplayName: v.productName,
        installerSidebar: v.sidebar,
        uninstallerSidebar: v.sidebar,
      },
    },
  });
}

(async () => {
  const which = process.argv[2] || 'all';
  const list = which === 'all' ? ['server', 'local'] : [which];
  for (const n of list) await buildVariant(n);
  // On remet la configuration « clients » par défaut
  fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(VARIANTS.server.config, null, 2));
  fs.writeFileSync(path.join(ROOT, 'build', 'installer.nsh'), installerScript(VARIANTS.server));
  console.log('\nTerminé.');
})().catch((e) => { console.error(e); process.exit(1); });
