// Pont sécurisé entre l'interface et le processus principal.
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const on = (channel) => (cb) => {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('sl', {
  info: () => call('app:info'),
  session: {
    get: () => call('session:get'),
    refresh: () => call('session:refresh'),
    login: (email, password) => call('session:login', email, password),
    logout: () => call('session:logout'),
    onChange: on('session:changed'),
  },
  settings: {
    get: () => call('settings:get'),
    set: (patch) => call('settings:set', patch),
    chooseFolder: () => call('settings:chooseFolder'),
    openFolder: () => call('settings:openFolder'),
    onChange: on('settings:changed'),
  },
  downloads: {
    list: () => call('downloads:list'),
    add: (url, quality) => call('downloads:add', url, quality),
    analyze: (url) => call('downloads:analyze', url),
    enqueue: (payload) => call('downloads:enqueue', payload),
    enqueuePlaylist: (payload) => call('downloads:enqueuePlaylist', payload),
    cancel: (id) => call('downloads:cancel', id),
    retry: (id) => call('downloads:retry', id),
    remove: (id, deleteFile) => call('downloads:remove', id, deleteFile),
    clear: () => call('downloads:clear'),
    open: (id) => call('downloads:open', id),
    reveal: (id) => call('downloads:reveal', id),
    onChange: on('downloads:changed'),
  },
  clipboard: {
    read: () => call('clipboard:read'),
    write: (text) => call('clipboard:write', text),
  },
  apiKey: {
    get: () => call('apikey:get'),
    generate: () => call('apikey:generate'),
    revoke: () => call('apikey:revoke'),
  },
  profile: {
    get: () => call('profile:get'),
    choosePhoto: () => call('profile:choosePhoto'),
    removePhoto: () => call('profile:removePhoto'),
    setName: (name) => call('profile:setName', name),
    onChange: on('profile:changed'),
  },
  engine: {
    update: () => call('engine:update'),
    onChange: on('engine:changed'),
  },
  openSite: (p) => call('open:site', p),
  win: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggleMaximize'),
    close: () => ipcRenderer.send('window:close'),
    onMaximized: on('window:maximized'),
  },
  onTheme: on('theme:updated'),
  onToast: on('toast'),
});
