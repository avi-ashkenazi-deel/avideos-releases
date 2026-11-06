// The UI's window into the Mac app: version, updates, Finder. Nothing else from Node is exposed.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('videditorDesktop', {
  info: () => ipcRenderer.invoke('app:info'),
  openHome: () => ipcRenderer.invoke('app:openHome'),
  update: {
    get: () => ipcRenderer.invoke('update:get'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    setAuto: (on) => ipcRenderer.invoke('update:setAuto', on),
    onState: (fn) => { const h = (_e, s) => fn(s); ipcRenderer.on('update:state', h); return () => ipcRenderer.removeListener('update:state', h); },
  },
});
window.addEventListener('DOMContentLoaded', () => { document.documentElement.classList.add('desktop', `os-${process.platform}`); });
