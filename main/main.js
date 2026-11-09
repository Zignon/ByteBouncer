'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { FtpEngine, DEFAULT_SETTINGS, listLocal, listDrives } = require('./ftp-engine');
const vpn = require('./vpn');

const VERSION = require('../package.json').version;
const TITLE = `ByteBouncer v${VERSION}`;
let win = null;
let engine = null;
let vpnMon = null;
let vpnState = { connected: false, proton: false, adapter: null };

const userData = () => app.getPath('userData');
const settingsFile = () => path.join(userData(), 'settings.json');
const sitesFile = () => path.join(userData(), 'sites.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function loadSettings() {
  return { ...DEFAULT_SETTINGS, downloadDir: path.join(os.homedir(), 'Downloads'), ...readJson(settingsFile(), {}) };
}

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

function createWindow() {
  win = new BrowserWindow({
    width: 1380, height: 880, minWidth: 980, minHeight: 620,
    title: TITLE,
    backgroundColor: '#061a4e',
    icon: path.join(__dirname, '..', 'renderer', 'logo.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  Menu.setApplicationMenu(null);
  win.on('page-title-updated', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  engine = new FtpEngine(loadSettings());
  engine.on('log', l => send('log', l));
  engine.on('stats', s => send('stats', s));
  engine.on('queue', q => send('queue', q));
  engine.on('connected', info => { send('connected', info); if (win) win.setTitle(`${TITLE}  —  ${info.site.user || 'anonymous'}@${info.site.host}`); });
  engine.on('disconnected', () => { send('disconnected'); if (win) win.setTitle(TITLE); });
  vpnMon = new vpn.VpnMonitor((st) => { vpnState = st; engine.setVpnStatus(st.connected); send('vpn', st); });
  createWindow();
});
app.on('window-all-closed', () => { if (vpnMon) vpnMon.stop(); if (engine) engine.destroy(); app.quit(); });

// ---------------------------------------------------------------- IPC
const h = (name, fn) => ipcMain.handle(name, async (_e, ...args) => fn(...args));

h('app:info', () => ({ version: VERSION, title: TITLE, home: os.homedir(), platform: process.platform, sep: path.sep }));
h('settings:get', () => loadSettings());
h('settings:set', (s) => { const merged = { ...loadSettings(), ...s }; writeJson(settingsFile(), merged); engine.updateSettings(merged); return merged; });
h('sites:get', () => readJson(sitesFile(), []));
h('sites:save', (sites) => { writeJson(sitesFile(), sites); return sites; });

h('vpn:status', () => vpnState);
h('vpn:open', () => vpn.openProton());
h('dialog:file', async () => { const r = await dialog.showOpenDialog(win, { properties: ['openFile'], title: 'Choose private key file' }); return r.canceled ? null : r.filePaths[0]; });

h('ftp:connect', (site) => engine.connect(site));
h('ftp:disconnect', () => engine.disconnect());
h('ftp:list', (dir) => engine.list(dir));
h('ftp:pwd', () => engine.pwd());
h('ftp:mkdir', (p) => engine.mkdir(p));
h('ftp:rename', (a, b) => engine.rename(a, b));
h('ftp:remove', (p, isDir) => engine.remove(p, isDir));
h('ftp:download', (entries, remoteDir, localDir) => engine.enqueueDownloads(entries, remoteDir, localDir));
h('ftp:upload', (localPaths, remoteDir) => engine.enqueueUploads(localPaths, remoteDir));

h('queue:cancel', (id) => engine.cancel(id));
h('queue:retry', (id) => engine.retry(id));
h('queue:remove', (id) => engine.removeItem(id));
h('queue:clear', () => engine.clearFinished());
h('queue:pause', (p) => engine.setPaused(p));

h('local:list', (dir) => listLocal(dir));
h('local:drives', () => listDrives());
h('local:mkdir', (p) => fs.promises.mkdir(p, { recursive: true }));
h('local:rename', (a, b) => fs.promises.rename(a, b));
h('local:remove', (p) => fs.promises.rm(p, { recursive: true, force: true }));
h('local:open', (p) => shell.openPath(p));
h('local:reveal', (p) => shell.showItemInFolder(p));
h('dialog:folder', async (def) => {
  const r = await dialog.showOpenDialog(win, { defaultPath: def, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
h('dialog:confirm', async (message, detail) => {
  const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Cancel', 'OK'], defaultId: 1, cancelId: 0, title: 'ByteBouncer', message, detail });
  return r.response === 1;
});
