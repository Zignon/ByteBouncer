'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch) => (cb) => { const fn = (_e, p) => cb(p); ipcRenderer.on(ch, fn); return () => ipcRenderer.removeListener(ch, fn); };

contextBridge.exposeInMainWorld('bb', {
  info: invoke('app:info'),
  settings: { get: invoke('settings:get'), set: invoke('settings:set') },
  sites: { get: invoke('sites:get'), save: invoke('sites:save') },
  ftp: {
    connect: invoke('ftp:connect'), disconnect: invoke('ftp:disconnect'), list: invoke('ftp:list'), pwd: invoke('ftp:pwd'),
    mkdir: invoke('ftp:mkdir'), rename: invoke('ftp:rename'), remove: invoke('ftp:remove'),
    download: invoke('ftp:download'), upload: invoke('ftp:upload'),
  },
  queue: { cancel: invoke('queue:cancel'), retry: invoke('queue:retry'), remove: invoke('queue:remove'), clear: invoke('queue:clear'), pause: invoke('queue:pause') },
  local: { list: invoke('local:list'), drives: invoke('local:drives'), mkdir: invoke('local:mkdir'), rename: invoke('local:rename'), remove: invoke('local:remove'), open: invoke('local:open'), reveal: invoke('local:reveal') },
  dialog: { folder: invoke('dialog:folder'), file: invoke('dialog:file'), confirm: invoke('dialog:confirm') },
  vpn: { status: invoke('vpn:status'), open: invoke('vpn:open') }, onVpn: on('vpn'),
  onLog: on('log'), onStats: on('stats'), onQueue: on('queue'), onConnected: on('connected'), onDisconnected: on('disconnected'),
});
