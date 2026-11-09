'use strict';
const $ = (id) => document.getElementById(id);
const api = window.bb;

const state = {
  info: null, settings: null, sites: [], siteSel: -1,
  connected: false,
  local: { path: '', entries: [], sel: new Set(), sort: ['type', 1] },
  remote: { path: '/', entries: [], sel: new Set(), sort: ['type', 1] },
  queue: [], speedHist: new Array(60).fill(0),
};

// ----------------------------------------------------------------- helpers
function fmt(b) {
  if (!b || b < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}
function fmtDate(ms) { if (!ms) return ''; const d = new Date(ms); return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function ext(name) { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toUpperCase() : ''; }
const pjoin = (a, b) => (a.endsWith('/') ? a : a + '/') + b;
const pparent = (p) => { const i = p.replace(/\/+$/, '').lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
function ljoin(a, b) { const sep = state.info.sep; return (a.endsWith(sep) ? a : a + sep) + b; }
function lparent(p) { const sep = state.info.sep; const t = p.replace(/[\\/]+$/, ''); const i = Math.max(t.lastIndexOf(sep), t.lastIndexOf('/')); if (i < 0) return p; let r = t.slice(0, i); if (/^[A-Za-z]:$/.test(r)) r += sep; if (r === '') r = sep; return r; }

function log(type, msg) {
  const el = $('log'); const d = document.createElement('div'); d.className = type;
  d.textContent = `${new Date().toLocaleTimeString()}  ${msg}`; el.appendChild(d);
  while (el.childElementCount > 600) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}
function toast(type, msg) { log(type, msg); }

// ----------------------------------------------------------------- modals / prompt
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => $(b.dataset.close).classList.remove('open')));
document.querySelectorAll('.modal').forEach(m => m.addEventListener('mousedown', e => { if (e.target === m) m.classList.remove('open'); }));
let promptResolve = null;
function prompt(title, value = '') {
  $('promptTitle').textContent = title; $('promptInput').value = value; $('mPrompt').classList.add('open');
  setTimeout(() => { $('promptInput').focus(); $('promptInput').select(); }, 30);
  return new Promise(r => { promptResolve = r; });
}
$('promptForm').addEventListener('submit', e => { e.preventDefault(); $('mPrompt').classList.remove('open'); const r = promptResolve; promptResolve = null; r && r($('promptInput').value); });
$('mPrompt').querySelector('[data-close]').addEventListener('click', () => { const r = promptResolve; promptResolve = null; r && r(null); });

// ----------------------------------------------------------------- file tables
function sortEntries(list, [key, dir]) {
  return [...list].sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (a.type !== 'dir' && b.type === 'dir') return 1;
    let r = 0;
    if (key === 'name' || key === 'type') r = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    else if (key === 'size') r = (a.size || 0) - (b.size || 0);
    else if (key === 'modified') r = (a.modified || 0) - (b.modified || 0);
    if (key === 'type' && r === 0) r = ext(a.name).localeCompare(ext(b.name));
    return r * dir;
  });
}

function renderTable(side) {
  const s = state[side]; const tbody = $(side + 'Table').querySelector('tbody');
  const rows = [];
  const isRoot = side === 'remote' ? s.path === '/' : lparent(s.path) === s.path;
  if (!isRoot) rows.push(`<tr class="parent" data-name=".."><td class="c-name">..</td><td class="c-size"></td><td class="c-type"></td><td class="c-date"></td>${side === 'remote' ? '<td></td>' : ''}</tr>`);
  let files = 0, dirs = 0, bytes = 0;
  for (const e of sortEntries(s.entries, s.sort)) {
    if (e.type === 'dir') dirs++; else { files++; bytes += e.size || 0; }
    rows.push(`<tr class="${e.type}${s.sel.has(e.name) ? ' sel' : ''}" data-name="${esc(e.name)}"><td class="c-name" title="${esc(e.name)}">${esc(e.name)}</td><td class="c-size">${e.type === 'dir' ? '' : fmt(e.size)}</td><td class="c-type">${e.type === 'dir' ? 'Folder' : (ext(e.name) || 'File')}</td><td class="c-date">${fmtDate(e.modified)}</td>${side === 'remote' ? `<td class="c-perm">${esc(e.perm || '')}</td>` : ''}</tr>`);
  }
  tbody.innerHTML = rows.join('');
  const selN = s.sel.size;
  $(side + 'Foot').textContent = selN ? `${selN} selected of ${files + dirs} items` : `${files} file${files === 1 ? '' : 's'} (${fmt(bytes)}), ${dirs} folder${dirs === 1 ? '' : 's'}`;
}

let lastClick = { side: null, name: null };
function bindTable(side) {
  const tbody = $(side + 'Table').querySelector('tbody'); const s = state[side];
  tbody.addEventListener('click', e => {
    const tr = e.target.closest('tr'); if (!tr) return; const name = tr.dataset.name; if (name === '..') return;
    if (e.ctrlKey || e.metaKey) { s.sel.has(name) ? s.sel.delete(name) : s.sel.add(name); }
    else if (e.shiftKey && lastClick.side === side && lastClick.name) {
      const order = sortEntries(s.entries, s.sort).map(x => x.name);
      const a = order.indexOf(lastClick.name), b = order.indexOf(name);
      s.sel = new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else { s.sel = new Set([name]); }
    if (!e.shiftKey) lastClick = { side, name };
    renderTable(side); updateButtons();
  });
  tbody.addEventListener('dblclick', e => {
    const tr = e.target.closest('tr'); if (!tr) return; const name = tr.dataset.name;
    if (name === '..') return side === 'remote' ? remoteGo(pparent(s.path)) : localGo(lparent(s.path));
    const en = s.entries.find(x => x.name === name); if (!en) return;
    if (en.type === 'dir') return side === 'remote' ? remoteGo(pjoin(s.path, name)) : localGo(ljoin(s.path, name));
    if (side === 'remote') transfer('download', [en]); else transfer('upload', [en]);
  });
  tbody.addEventListener('contextmenu', e => {
    e.preventDefault(); const tr = e.target.closest('tr'); const name = tr && tr.dataset.name;
    if (name && name !== '..' && !s.sel.has(name)) { s.sel = new Set([name]); renderTable(side); updateButtons(); }
    showCtx(side, e.clientX, e.clientY);
  });
  $(side + 'Table').querySelector('thead').addEventListener('click', e => {
    const th = e.target.closest('th'); if (!th) return;
    const key = th.classList.contains('c-size') ? 'size' : th.classList.contains('c-type') ? 'type' : th.classList.contains('c-date') ? 'modified' : 'name';
    s.sort = s.sort[0] === key ? [key, -s.sort[1]] : [key, 1]; renderTable(side);
  });
}
bindTable('local'); bindTable('remote');

function selected(side) { const s = state[side]; return s.entries.filter(e => s.sel.has(e.name)); }
function updateButtons() {
  $('btnDownload').disabled = !state.connected || selected('remote').length === 0;
  $('btnUpload').disabled = !state.connected || selected('local').length === 0;
}

// ----------------------------------------------------------------- local pane
async function localGo(p) {
  try {
    const entries = await api.local.list(p);
    state.local.path = p; state.local.entries = entries; state.local.sel.clear();
    $('localPath').value = p; renderTable('local'); updateButtons();
    const drv = $('localDrives'); const root = p.slice(0, 3).toUpperCase();
    [...drv.options].forEach(o => { if (o.value.toUpperCase() === root) drv.value = o.value; });
  } catch (e) { toast('error', `Local: ${e.message}`); }
}
$('localUp').addEventListener('click', () => localGo(lparent(state.local.path)));
$('localRefresh').addEventListener('click', () => localGo(state.local.path));
$('localPath').addEventListener('keydown', e => { if (e.key === 'Enter') localGo($('localPath').value); });
$('localDrives').addEventListener('change', () => localGo($('localDrives').value));
$('localBrowse').addEventListener('click', async () => { const d = await api.dialog.folder(state.local.path); if (d) localGo(d); });

// ----------------------------------------------------------------- remote pane
async function remoteGo(p) {
  if (!state.connected) return;
  try {
    const entries = await api.ftp.list(p);
    state.remote.path = p; state.remote.entries = entries; state.remote.sel.clear();
    $('remotePath').value = p; renderTable('remote'); updateButtons();
  } catch (e) { toast('error', `Remote: ${e.message}`); }
}
$('remoteUp').addEventListener('click', () => remoteGo(pparent(state.remote.path)));
$('remoteRefresh').addEventListener('click', () => remoteGo(state.remote.path));
$('remotePath').addEventListener('keydown', e => { if (e.key === 'Enter') remoteGo($('remotePath').value || '/'); });
$('remoteMkdir').addEventListener('click', () => remoteMkdir());
async function remoteMkdir() {
  const name = await prompt('New remote folder name'); if (!name) return;
  try { await api.ftp.mkdir(pjoin(state.remote.path, name)); await remoteGo(state.remote.path); } catch (e) { toast('error', e.message); }
}

// ----------------------------------------------------------------- transfers
async function transfer(kind, entries) {
  if (!state.connected || !entries.length) return;
  try {
    if (kind === 'download') { await api.ftp.download(entries.map(e => ({ name: e.name, type: e.type, size: e.size })), state.remote.path, state.local.path); }
    else { await api.ftp.upload(entries.map(e => ljoin(state.local.path, e.name)), state.remote.path); setTimeout(() => remoteGo(state.remote.path), 800); }
  } catch (e) { toast('error', e.message); }
}
$('btnDownload').addEventListener('click', () => transfer('download', selected('remote')));
$('btnUpload').addEventListener('click', () => transfer('upload', selected('local')));

// ----------------------------------------------------------------- context menu
const ctx = $('ctx');
function showCtx(side, x, y) {
  const sel = selected(side); const one = sel.length === 1 ? sel[0] : null;
  const items = [];
  if (side === 'remote') {
    if (sel.length) items.push(['⬇ Download', () => transfer('download', sel)]);
    items.push(['✚ New folder', remoteMkdir]);
    if (one) items.push(['✎ Rename', async () => { const n = await prompt('Rename to', one.name); if (n && n !== one.name) { try { await api.ftp.rename(pjoin(state.remote.path, one.name), pjoin(state.remote.path, n)); remoteGo(state.remote.path); } catch (e) { toast('error', e.message); } } }]);
    if (sel.length) items.push(['hr'], ['🗑 Delete', async () => {
      if (!await api.dialog.confirm(`Delete ${sel.length} item(s) from the server?`, sel.map(s => s.name).join('\n'))) return;
      for (const e of sel) { try { await api.ftp.remove(pjoin(state.remote.path, e.name), e.type === 'dir'); } catch (err) { toast('error', `${e.name}: ${err.message}`); } }
      remoteGo(state.remote.path);
    }, 'danger']);
    items.push(['hr'], ['↻ Refresh', () => remoteGo(state.remote.path)]);
  } else {
    if (sel.length) items.push(['⬆ Upload', () => transfer('upload', sel)]);
    if (one) items.push(['Open', () => api.local.open(ljoin(state.local.path, one.name))], ['Show in Explorer', () => api.local.reveal(ljoin(state.local.path, one.name))]);
    items.push(['✚ New folder', async () => { const n = await prompt('New local folder name'); if (n) { await api.local.mkdir(ljoin(state.local.path, n)); localGo(state.local.path); } }]);
    if (one) items.push(['✎ Rename', async () => { const n = await prompt('Rename to', one.name); if (n && n !== one.name) { try { await api.local.rename(ljoin(state.local.path, one.name), ljoin(state.local.path, n)); localGo(state.local.path); } catch (e) { toast('error', e.message); } } }]);
    if (sel.length) items.push(['hr'], ['🗑 Delete', async () => {
      if (!await api.dialog.confirm(`Delete ${sel.length} local item(s)?`, sel.map(s => s.name).join('\n'))) return;
      for (const e of sel) { try { await api.local.remove(ljoin(state.local.path, e.name)); } catch (err) { toast('error', err.message); } }
      localGo(state.local.path);
    }, 'danger']);
    items.push(['hr'], ['↻ Refresh', () => localGo(state.local.path)]);
  }
  ctx.innerHTML = '';
  for (const it of items) {
    const li = document.createElement('li');
    if (it[0] === 'hr' && it.length === 1) { li.className = 'hr'; } else { li.textContent = it[0]; if (it[2]) li.classList.add(it[2]); li.addEventListener('click', () => { hideCtx(); it[1](); }); }
    ctx.appendChild(li);
  }
  ctx.style.display = 'block';
  const r = ctx.getBoundingClientRect();
  ctx.style.left = Math.min(x, window.innerWidth - r.width - 4) + 'px';
  ctx.style.top = Math.min(y, window.innerHeight - r.height - 4) + 'px';
}
function hideCtx() { ctx.style.display = 'none'; }
document.addEventListener('mousedown', e => { if (!ctx.contains(e.target)) hideCtx(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { hideCtx(); document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open')); }
  if (e.key === 'F5') { localGo(state.local.path); if (state.connected) remoteGo(state.remote.path); }
});

// ----------------------------------------------------------------- connect
async function connect(site) {
  $('btnConnect').disabled = true;
  try {
    const r = await api.ftp.connect(site);
    state.connected = true; $('btnDisconnect').disabled = false; $('remotePath').disabled = false;
    $('remoteEmpty').classList.add('hidden'); $('connDot').classList.add('on');
    $('connText').textContent = `${site.user || 'anonymous'}@${site.host}:${site.port || (site.protocol === 'sftp' ? 22 : site.protocol === 'ftps-implicit' ? 990 : 21)} (${site.protocol === 'ftp' ? 'FTP' : site.protocol === 'sftp' ? 'SFTP' : 'FTPS'})`;
    if (site.localDir) localGo(site.localDir);
    await remoteGo(r.cwd || '/');
  } catch (e) { toast('error', `Connection failed: ${e.message}`); }
  finally { $('btnConnect').disabled = false; updateButtons(); }
}
function onDisconnected() {
  state.connected = false; $('btnDisconnect').disabled = true; $('remotePath').disabled = true; $('remotePath').value = '';
  state.remote.entries = []; state.remote.sel.clear(); renderTable('remote');
  $('remoteEmpty').classList.remove('hidden'); $('connDot').classList.remove('on'); $('connText').textContent = 'Not connected'; updateButtons();
}
$('qc').addEventListener('submit', e => {
  e.preventDefault();
  const site = { host: $('qcHost').value.trim(), port: Number($('qcPort').value) || undefined, user: $('qcUser').value.trim(), password: $('qcPass').value, protocol: $('qcProto').value };
  if (!site.host) { $('qcHost').focus(); return; }
  const m = site.host.match(/^(ftps?|sftp):\/\/([^/]+)/i); if (m) { site.host = m[2]; if (m[1].toLowerCase() === 'sftp') site.protocol = 'sftp'; $('qcProto').value = site.protocol; }
  connect(site);
});
$('btnDisconnect').addEventListener('click', () => api.ftp.disconnect());

// ----------------------------------------------------------------- queue rendering
function renderQueue() {
  const tbody = $('queueTable').querySelector('tbody');
  const seen = new Set();
  for (const it of state.queue) {
    seen.add(String(it.id));
    let tr = tbody.querySelector(`tr[data-id="${it.id}"]`);
    if (!tr) {
      tr = document.createElement('tr'); tr.dataset.id = it.id;
      tr.innerHTML = `<td class="c-dir ${it.type === 'download' ? 'down' : 'up'}">${it.type === 'download' ? '⬇' : '⬆'}</td><td class="c-name" title="${esc(it.type === 'download' ? it.remotePath + ' → ' + it.localPath : it.localPath + ' → ' + it.remotePath)}">${esc(it.name)}</td><td class="c-size">${fmt(it.size)}</td><td class="c-prog"><div class="prog"><i></i><b></b></div></td><td class="c-speed"></td><td class="c-conn"></td><td class="c-status"></td><td class="c-act"></td>`;
      tr.querySelector('.c-act').addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.a === 'cancel') api.queue.cancel(it.id); if (b.dataset.a === 'retry') api.queue.retry(it.id); if (b.dataset.a === 'remove') api.queue.remove(it.id);
      });
      tbody.appendChild(tr);
    }
    const pct = it.size ? Math.min(100, it.transferred / it.size * 100) : (it.status === 'done' ? 100 : 0);
    const prog = tr.querySelector('.prog'); prog.classList.toggle('done', it.status === 'done');
    prog.querySelector('i').style.width = pct + '%'; prog.querySelector('b').textContent = it.status === 'queued' ? '' : `${pct.toFixed(it.size > 50e6 ? 1 : 0)}%`;
    tr.querySelector('.c-size').textContent = fmt(it.size);
    tr.querySelector('.c-speed').textContent = it.status === 'running' ? fmt(it.speed) + '/s' : '';
    tr.querySelector('.c-conn').textContent = it.status === 'running' ? `×${it.connections}` : '';
    const st = tr.querySelector('.c-status'); st.className = `c-status st-${it.status}`;
    st.textContent = it.status === 'error' ? `Error: ${it.error || ''}` : (it.status === 'queued' && vpnBlocked) ? 'Waiting for VPN' : it.status === 'running' ? (it.connections > 1 ? `Downloading (${it.connections} streams)` : (it.type === 'download' ? 'Downloading' : 'Uploading')) : it.status.charAt(0).toUpperCase() + it.status.slice(1);
    st.title = it.error || '';
    const act = tr.querySelector('.c-act');
    const wanted = it.status === 'running' || it.status === 'queued' || it.status === 'starting' ? 'cancel' : (it.status === 'done' ? 'remove' : 'retry');
    if (act.dataset.mode !== wanted) {
      act.dataset.mode = wanted;
      act.innerHTML = wanted === 'cancel' ? '<button class="qact" data-a="cancel" title="Cancel">✖</button>' : wanted === 'remove' ? '<button class="qact" data-a="remove" title="Remove">✖</button>' : '<button class="qact" data-a="retry" title="Retry">↻</button><button class="qact" data-a="remove" title="Remove">✖</button>';
    }
  }
  for (const tr of [...tbody.children]) if (!seen.has(tr.dataset.id)) tr.remove();
}
$('btnClear').addEventListener('click', () => api.queue.clear());
let paused = false;
$('btnPause').addEventListener('click', () => { paused = !paused; api.queue.pause(paused); $('btnPause').textContent = paused ? 'Resume queue' : 'Pause queue'; $('btnPause').classList.toggle('btn-accent', paused); });

// ----------------------------------------------------------------- stats + sparkline
function drawSpark() {
  const c = $('spark'); const g = c.getContext('2d'); const w = c.width, h = c.height;
  g.clearRect(0, 0, w, h);
  const max = Math.max(1, ...state.speedHist);
  const grad = g.createLinearGradient(0, 0, 0, h); grad.addColorStop(0, 'rgba(255,196,107,.9)'); grad.addColorStop(1, 'rgba(255,154,60,.05)');
  g.beginPath(); g.moveTo(0, h);
  state.speedHist.forEach((v, i) => g.lineTo(i / (state.speedHist.length - 1) * w, h - v / max * (h - 3)));
  g.lineTo(w, h); g.closePath(); g.fillStyle = grad; g.fill();
  g.beginPath(); state.speedHist.forEach((v, i) => { const x = i / (state.speedHist.length - 1) * w, y = h - v / max * (h - 3); i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.strokeStyle = '#ffc46b'; g.lineWidth = 1.5; g.stroke();
}
api.onStats(s => {
  $('stSpeed').textContent = fmt(s.speed) + '/s'; $('stActive').textContent = s.active; $('stConn').textContent = `${s.connections} / ${s.maxConnections}`; $('stQueued').textContent = s.queued;
  state.speedHist.push(s.speed); state.speedHist.shift(); drawSpark();
  if (vpnBlocked !== !!s.vpnBlocked) { vpnBlocked = !!s.vpnBlocked; renderQueue(); }
  if (state.connected && !s.connected) onDisconnected();
});
let doneSeen = new Set(), refreshT = null, vpnBlocked = false;
api.onQueue(q => {
  state.queue = q; renderQueue();
  let dl = false, ul = false;
  for (const it of q) if (it.status === 'done' && !doneSeen.has(it.id)) { doneSeen.add(it.id); if (it.type === 'download') dl = true; else ul = true; }
  if (dl || ul) { clearTimeout(refreshT); refreshT = setTimeout(() => { if (dl) localGo(state.local.path); if (ul && state.connected) remoteGo(state.remote.path); }, 600); }
});
api.onLog(l => log(l.type, l.msg));
api.onDisconnected(() => onDisconnected());
api.onConnected(info => { /* handled in connect() */ });
$('chkLog').addEventListener('change', () => $('logPane').classList.toggle('hidden', !$('chkLog').checked));

// ----------------------------------------------------------------- vpn
state.vpn = { connected: false, proton: false, adapter: null };
function renderVpn() {
  const v = state.vpn, badge = $('vpnBadge'), req = state.settings && state.settings.requireVpn;
  badge.classList.toggle('on', v.connected); badge.classList.toggle('blocked', !v.connected && !!req);
  $('vpnText').textContent = v.connected ? `VPN: ${v.proton ? 'Proton VPN' : v.adapter}${req ? ' · kill switch armed' : ''}` : req ? 'VPN off · transfers blocked' : 'VPN: off';
  badge.title = v.adapter ? `Tunnel adapter: ${v.adapter}` : 'No VPN tunnel adapter detected';
  $('btnVpn').style.display = v.proton ? 'none' : '';
}
api.onVpn(v => { state.vpn = v; renderVpn(); });
$('btnVpn').addEventListener('click', async () => { const r = await api.vpn.open(); toast('status', r.launched ? 'Launching Proton VPN…' : 'Proton VPN app not found - opened the download page.'); });

// ----------------------------------------------------------------- site manager
function renderSites() {
  const ul = $('siteList'); ul.innerHTML = '';
  state.sites.forEach((s, i) => { const li = document.createElement('li'); li.textContent = s.name || s.host || '(unnamed)'; if (i === state.siteSel) li.classList.add('sel'); li.addEventListener('click', () => { state.siteSel = i; renderSites(); fillSiteForm(); }); ul.appendChild(li); });
}
function fillSiteForm() {
  const s = state.sites[state.siteSel] || {};
  $('sName').value = s.name || ''; $('sHost').value = s.host || ''; $('sPort').value = s.port || ''; $('sProto').value = s.protocol || 'ftp';
  $('sUser').value = s.user || ''; $('sPass').value = s.password || ''; $('sKey').value = s.keyFile || ''; $('sKeyRow').classList.toggle('hidden', $('sProto').value !== 'sftp'); $('sDir').value = s.remoteDir || ''; $('sLocal').value = s.localDir || '';
}
function readSiteForm() { return { name: $('sName').value.trim() || $('sHost').value.trim(), host: $('sHost').value.trim(), port: Number($('sPort').value) || undefined, protocol: $('sProto').value, user: $('sUser').value.trim(), password: $('sPass').value, keyFile: $('sKey').value.trim(), remoteDir: $('sDir').value.trim(), localDir: $('sLocal').value.trim() }; }
$('sProto').addEventListener('change', () => { $('sKeyRow').classList.toggle('hidden', $('sProto').value !== 'sftp'); if (!$('sPort').value) $('sPort').placeholder = $('sProto').value === 'sftp' ? '22' : $('sProto').value === 'ftps-implicit' ? '990' : '21'; });
$('sKeyBrowse').addEventListener('click', async () => { const f = await api.dialog.file(); if (f) $('sKey').value = f; });
$('qcProto').addEventListener('change', () => { $('qcPort').placeholder = $('qcProto').value === 'sftp' ? '22' : $('qcProto').value === 'ftps-implicit' ? '990' : '21'; });
$('btnSites').addEventListener('click', () => { $('mSites').classList.add('open'); renderSites(); fillSiteForm(); });
$('siteNew').addEventListener('click', () => { state.sites.push({ name: 'New site', protocol: 'ftp' }); state.siteSel = state.sites.length - 1; renderSites(); fillSiteForm(); $('sName').focus(); $('sName').select(); });
$('siteDelete').addEventListener('click', async () => { if (state.siteSel < 0) return; state.sites.splice(state.siteSel, 1); state.siteSel = -1; await api.sites.save(state.sites); renderSites(); fillSiteForm(); });
$('siteSave').addEventListener('click', async () => {
  const s = readSiteForm(); if (!s.host) { $('sHost').focus(); return; }
  if (state.siteSel < 0) { state.sites.push(s); state.siteSel = state.sites.length - 1; } else state.sites[state.siteSel] = s;
  await api.sites.save(state.sites); renderSites(); toast('status', `Site "${s.name}" saved.`);
});
$('siteConnect').addEventListener('click', async () => { const s = readSiteForm(); if (!s.host) { $('sHost').focus(); return; } $('mSites').classList.remove('open'); connect(s); });

// ----------------------------------------------------------------- settings
function fillSettings() {
  const s = state.settings;
  $('setMaxTransfers').value = s.maxTransfers; $('setConnPerFile').value = s.connectionsPerFile; $('setMaxConn').value = s.maxConnections; $('setSegMin').value = s.segmentMinMB;
  $('setOverwrite').value = s.overwrite; $('setDownloadDir').value = s.downloadDir || ''; $('setAnyCert').checked = !!s.acceptAnyCert; $('setRequireVpn').checked = !!s.requireVpn; $('setTimeout').value = s.timeoutSec;
}
$('btnSettings').addEventListener('click', () => { fillSettings(); $('mSettings').classList.add('open'); });
$('settingsForm').addEventListener('submit', async e => {
  e.preventDefault();
  const s = {
    maxTransfers: Math.max(1, Number($('setMaxTransfers').value) || 1), connectionsPerFile: Math.max(1, Number($('setConnPerFile').value) || 1),
    maxConnections: Math.max(1, Number($('setMaxConn').value) || 1), segmentMinMB: Math.max(0.25, Number($('setSegMin').value) || 2),
    overwrite: $('setOverwrite').value, downloadDir: $('setDownloadDir').value.trim(), acceptAnyCert: $('setAnyCert').checked, requireVpn: $('setRequireVpn').checked, timeoutSec: Math.max(5, Number($('setTimeout').value) || 60),
  };
  state.settings = await api.settings.set(s); $('mSettings').classList.remove('open'); toast('status', 'Settings saved.'); renderVpn();
});

// ----------------------------------------------------------------- init
(async () => {
  state.info = await api.info(); $('brandVer').textContent = `v${state.info.version}`;
  state.settings = await api.settings.get(); state.sites = await api.sites.get();
  state.vpn = await api.vpn.status(); renderVpn();
  const drives = await api.local.drives(); $('localDrives').innerHTML = drives.map(d => `<option value="${esc(d)}">${esc(d.replace(/\\$/, ''))}</option>`).join('');
  await localGo(state.settings.downloadDir || state.info.home);
  log('status', `ByteBouncer v${state.info.version} ready. Enter a host above or open the Site Manager.`);
  renderTable('remote'); updateButtons(); drawSpark();
  $('qcHost').focus();
})();
