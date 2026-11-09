'use strict';
/**
 * ByteBouncer transfer engine.
 *
 * - One "control" connection is used for browsing (LIST / MKD / DELE / RNFR ...).
 * - Transfers run on their own pool of data connections.
 * - Large downloads are split into segments and fetched over several
 *   connections at once (REST + RETR on each), which is what lets a single
 *   file saturate the downloading machine's bandwidth even when the server
 *   throttles each connection.
 * - Several files transfer concurrently on top of that.
 */
const ftp = require('basic-ftp');
const { SftpClient } = require('./sftp-client');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Writable, Transform } = require('stream');
const EventEmitter = require('events');

const posix = path.posix;

const DEFAULT_SETTINGS = {
  maxTransfers: 3,          // files transferring at the same time
  connectionsPerFile: 4,    // segments / connections for one large download
  maxConnections: 10,       // cap on simultaneous data connections (browsing connection is extra)
  segmentMinMB: 2,          // files smaller than this use one connection
  overwrite: 'overwrite',   // overwrite | skip
  acceptAnyCert: true,
  timeoutSec: 60,
  requireVpn: false,       // kill switch: no transfers unless a VPN tunnel is up
};

class Semaphore {
  constructor(max) { this.max = max; this.used = 0; this.waiters = []; }
  tryAcquire(n = 1) { if (this.used + n <= this.max) { this.used += n; return true; } return false; }
  acquire() { if (this.tryAcquire()) return Promise.resolve(); return new Promise(r => this.waiters.push(r)); }
  release(n = 1) { this.used = Math.max(0, this.used - n); this._wake(); }
  setMax(n) { this.max = n; this._wake(); }
  available() { return Math.max(0, this.max - this.used); }
  _wake() { while (this.waiters.length && this.used < this.max) { this.used++; this.waiters.shift()(); } }
}

class Mutex {
  constructor() { this.p = Promise.resolve(); }
  run(fn) {
    const next = this.p.then(() => fn());
    this.p = next.catch(() => {});
    return next;
  }
}

let nextId = 1;
const sleep = ms => new Promise(r => setTimeout(r, ms));

class FtpEngine extends EventEmitter {
  constructor(settings = {}) {
    super();
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.site = null;
    this.control = null;
    this.features = new Map();
    this.controlLock = new Mutex();
    this.sem = new Semaphore(this.settings.maxConnections);
    this.queue = [];
    this.active = 0;
    this.paused = false;
    this.bytesTick = 0;
    this.speedSamples = [];
    this._tick = setInterval(() => this._onTick(), 500);
    this._queueDirty = false;
    this.connectedSince = null;
    this.vpnOk = false;
    this.liveData = new Set();
  }

  // ---------------------------------------------------------------- vpn kill switch
  transfersBlocked() { return !!this.settings.requireVpn && !this.vpnOk; }
  setVpnStatus(ok) {
    const was = this.vpnOk; this.vpnOk = !!ok;
    if (this.settings.requireVpn && was && !ok) {
      let n = 0;
      for (const it of this.queue) if (it.status === 'running' || it.status === 'starting') { it.requeue = true; this.cancel(it.id); n++; }
      this.log('error', `VPN tunnel dropped - kill switch stopped ${n} active transfer${n === 1 ? '' : 's'}; they will resume when the VPN is back.`);
    }
    if (ok && !was && this.settings.requireVpn) this.log('status', 'VPN tunnel detected - transfers allowed.');
    this._dirty(); this._pump();
  }

  // ---------------------------------------------------------------- settings
  updateSettings(s) {
    const hadRequire = this.settings.requireVpn;
    this.settings = { ...this.settings, ...s };
    if (this.settings.requireVpn && !hadRequire && !this.vpnOk) { this.vpnOk = true; this.setVpnStatus(false); }
    this.sem.setMax(Math.max(1, this.settings.maxConnections | 0));
    this._pump();
  }

  log(type, msg) { this.emit('log', { type, msg, at: Date.now() }); }

  // ------------------------------------------------------------- connections
  _accessOptions(site) {
    if (site.protocol === 'sftp') return { host: site.host, port: Number(site.port) || 22, user: site.user, password: site.password, keyFile: site.keyFile };
    const secure = site.protocol === 'ftps' ? true : site.protocol === 'ftps-implicit' ? 'implicit' : false;
    return {
      host: site.host,
      port: Number(site.port) || (secure === 'implicit' ? 990 : 21),
      user: site.user || 'anonymous',
      password: site.password || (site.user ? '' : 'bytebouncer@'),
      secure,
      secureOptions: { rejectUnauthorized: !this.settings.acceptAnyCert },
    };
  }

  async _newClient(tag = 'data') {
    const client = this.site.protocol === 'sftp' ? new SftpClient(this.settings.timeoutSec * 1000) : new ftp.Client(this.settings.timeoutSec * 1000);
    client.ftp.log = (m) => { if (tag !== 'control') return; const t = String(m).trim(); if (/^[<>]|^[A-Z][a-z]+ /.test(t) && !/^[-dl][rwx-]{9}/.test(t)) this.log('proto', t.split('\n')[0]); };
    await client.access(this._accessOptions(this.site));
    try { await client.send('TYPE I'); } catch (_) { /* some servers refuse, fine */ }
    if (tag !== 'control') {
      // track live data connections so the server's login cap can be learned exactly
      this.liveData.add(client);
      const origClose = client.close.bind(client);
      client.close = () => { this.liveData.delete(client); origClose(); };
    }
    return client;
  }

  async connect(site) {
    await this.disconnect();
    this.site = site;
    this.sem.setMax(Math.max(1, this.settings.maxConnections | 0)); this.learnedCap = 0;
    this.log('status', `Connecting to ${site.host}:${site.port || 21} ...`);
    this.control = await this._newClient('control');
    try { this.features = await this.control.features(); } catch (_) { this.features = new Map(); }
    const cwd = site.remoteDir ? site.remoteDir : await this.control.pwd();
    if (site.remoteDir) { try { await this.control.cd(site.remoteDir); } catch (e) { this.log('error', `Cannot open ${site.remoteDir}: ${e.message}`); } }
    this.connectedSince = Date.now();
    const rest = this.features.has('REST');
    this.log('status', site.protocol === 'sftp' ? 'Connected over SSH (encrypted). Segmented downloads enabled.' : `Connected. Server ${rest ? 'supports' : 'does NOT support'} REST - segmented downloads ${rest ? 'enabled' : 'disabled'}.`);
    this.emit('connected', { site: { ...site, password: undefined }, cwd: await this.control.pwd() });
    return { cwd: await this.control.pwd(), features: [...this.features.keys()] };
  }

  async disconnect() {
    if (this.control) {
      const c = this.control; this.control = null;
      try { c.close(); } catch (_) {}
      this.log('status', 'Disconnected.');
      this.emit('disconnected');
    }
    this.connectedSince = null;
  }

  isConnected() { return !!this.control && !this.control.closed; }

  _ctl(fn) {
    if (!this.isConnected()) return Promise.reject(new Error('Not connected'));
    return this.controlLock.run(async () => {
      try { return await fn(this.control); }
      catch (e) {
        if (this.control && this.control.closed) { this.log('error', 'Control connection lost, reconnecting...'); this.control = await this._newClient('control'); return await fn(this.control); }
        throw e;
      }
    });
  }

  // ------------------------------------------------------------- browsing
  async list(dir) {
    return this._ctl(async (c) => {
      const items = await c.list(dir);
      return items.map(f => ({
        name: f.name,
        size: f.size,
        type: f.isDirectory ? 'dir' : f.isSymbolicLink ? 'link' : 'file',
        modified: f.modifiedAt ? f.modifiedAt.getTime() : null,
        raw: f.rawModifiedAt || '',
        perm: f.permissions ? `${f.permissions.user}${f.permissions.group}${f.permissions.world}` : '',
      })).filter(f => f.name !== '.' && f.name !== '..');
    });
  }
  pwd() { return this._ctl(c => c.pwd()); }
  mkdir(p) { return this._ctl(c => c.ensureDir(p)); }
  rename(a, b) { return this._ctl(c => c.rename(a, b)); }
  remove(p, isDir) { return this._ctl(c => isDir ? c.removeDir(p) : c.remove(p)); }
  size(p) { return this._ctl(c => c.size(p)); }

  // ------------------------------------------------------------- queue
  _item(base) {
    const it = {
      id: nextId++, status: 'queued', transferred: 0, size: base.size || 0,
      speed: 0, connections: 0, error: null, added: Date.now(), ...base,
    };
    it._bytesTick = 0; it._samples = []; it._clients = new Set();
    return it;
  }
  _snapshot() {
    return this.queue.map(it => {
      const { _clients, _bytesTick, _samples, ...pub } = it; return pub;
    });
  }
  _dirty() { this._queueDirty = true; }

  async enqueueDownload(remotePath, localDir, isDir) {
    if (isDir) {
      const name = posix.basename(remotePath);
      const localRoot = path.join(localDir, name);
      await fsp.mkdir(localRoot, { recursive: true });
      await this._walkRemote(remotePath, localRoot);
    } else {
      const name = posix.basename(remotePath);
      let size = 0;
      try { size = await this.size(remotePath); } catch (_) {}
      this.queue.push(this._item({ type: 'download', remotePath, localPath: path.join(localDir, name), name, size }));
    }
    this._dirty(); this._pump();
  }

  async enqueueDownloads(entries, remoteDir, localDir) {
    for (const e of entries) {
      const rp = posix.join(remoteDir, e.name);
      if (e.type === 'dir') await this.enqueueDownload(rp, localDir, true);
      else { this.queue.push(this._item({ type: 'download', remotePath: rp, localPath: path.join(localDir, e.name), name: e.name, size: e.size || 0 })); }
    }
    this._dirty(); this._pump();
  }

  async _walkRemote(remoteDir, localDir) {
    let entries;
    try { entries = await this.list(remoteDir); } catch (e) { this.log('error', `Cannot list ${remoteDir}: ${e.message}`); return; }
    for (const e of entries) {
      const rp = posix.join(remoteDir, e.name);
      if (e.type === 'dir') {
        const ld = path.join(localDir, e.name);
        await fsp.mkdir(ld, { recursive: true });
        await this._walkRemote(rp, ld);
      } else {
        this.queue.push(this._item({ type: 'download', remotePath: rp, localPath: path.join(localDir, e.name), name: e.name, size: e.size || 0 }));
        this._dirty(); this._pump();
      }
    }
  }

  async enqueueUploads(localPaths, remoteDir) {
    for (const lp of localPaths) {
      let st;
      try { st = await fsp.stat(lp); } catch (e) { this.log('error', `Cannot read ${lp}: ${e.message}`); continue; }
      if (st.isDirectory()) await this._walkLocal(lp, posix.join(remoteDir, path.basename(lp)));
      else this.queue.push(this._item({ type: 'upload', localPath: lp, remotePath: posix.join(remoteDir, path.basename(lp)), name: path.basename(lp), size: st.size }));
    }
    this._dirty(); this._pump();
  }

  async _walkLocal(localDir, remoteDir) {
    const entries = await fsp.readdir(localDir, { withFileTypes: true });
    // make sure empty folders also get created remotely
    try { await this.mkdir(remoteDir); } catch (e) { this.log('error', `mkdir ${remoteDir}: ${e.message}`); }
    for (const d of entries) {
      const lp = path.join(localDir, d.name);
      if (d.isDirectory()) await this._walkLocal(lp, posix.join(remoteDir, d.name));
      else if (d.isFile()) {
        const st = await fsp.stat(lp);
        this.queue.push(this._item({ type: 'upload', localPath: lp, remotePath: posix.join(remoteDir, d.name), name: d.name, size: st.size }));
        this._dirty(); this._pump();
      }
    }
  }

  cancel(id) {
    const it = this.queue.find(i => i.id === id);
    if (!it) return;
    if (it.status === 'running') {
      it.cancelled = true;
      for (const c of it._clients) { try { c.close(); } catch (_) {} }
    } else if (it.status === 'queued') { it.status = 'cancelled'; }
    this._dirty();
  }
  retry(id) {
    const it = this.queue.find(i => i.id === id);
    if (it && (it.status === 'error' || it.status === 'cancelled' || it.status === 'skipped')) {
      it.status = 'queued'; it.error = null; it.transferred = 0; it.cancelled = false; this._dirty(); this._pump();
    }
  }
  removeItem(id) {
    const it = this.queue.find(i => i.id === id);
    if (!it) return;
    if (it.status === 'running') this.cancel(id);
    this.queue = this.queue.filter(i => i.id !== id); this._dirty();
  }
  clearFinished() { this.queue = this.queue.filter(i => !['done', 'cancelled', 'skipped', 'error'].includes(i.status)); this._dirty(); }
  setPaused(p) { this.paused = !!p; this._dirty(); this._pump(); }

  // ------------------------------------------------------------- scheduler
  _pump() {
    if (this.paused || !this.site || this.transfersBlocked()) return;
    while (this.active < this.settings.maxTransfers) {
      const next = this.queue.find(i => i.status === 'queued');
      if (!next) break;
      next.status = 'starting';
      this.active++;
      const run = next.type === 'download' ? this._download(next) : this._upload(next);
      run.catch(e => { next.status = 'error'; next.error = e.message; })
        .finally(() => { this.active--; this._dirty(); this._pump(); });
    }
    this._dirty();
  }

  _onTick() {
    // global speed (2 samples / sec, 2 second rolling average)
    this.speedSamples.push(this.bytesTick * 2); this.bytesTick = 0;
    if (this.speedSamples.length > 4) this.speedSamples.shift();
    const speed = this.speedSamples.reduce((a, b) => a + b, 0) / this.speedSamples.length;
    for (const it of this.queue) {
      if (it.status !== 'running') { it.speed = 0; continue; }
      it._samples.push(it._bytesTick * 2); it._bytesTick = 0;
      if (it._samples.length > 4) it._samples.shift();
      it.speed = it._samples.reduce((a, b) => a + b, 0) / it._samples.length;
    }
    const stats = {
      speed, active: this.active, connections: this.sem.used, maxConnections: this.sem.max,
      queued: this.queue.filter(i => i.status === 'queued').length, paused: this.paused,
      connected: this.isConnected(), vpnBlocked: this.transfersBlocked(),
    };
    this.emit('stats', stats);
    if (this._queueDirty || this.active > 0) { this._queueDirty = false; this.emit('queue', this._snapshot()); }
  }

  // ------------------------------------------------------------- download
  async _download(it) {
    it.status = 'running'; it.transferred = 0; it.started = Date.now();
    await fsp.mkdir(path.dirname(it.localPath), { recursive: true });
    if (this.settings.overwrite === 'skip' && fs.existsSync(it.localPath)) { it.status = 'skipped'; return; }

    await this.sem.acquire();
    let slots = 1;
    try {
      if (!it.size) { const c = await this._newClient(); try { it.size = await c.size(it.remotePath); } catch (_) {} finally { c.close(); } }
      const segMin = Math.max(256 * 1024, this.settings.segmentMinMB * 1024 * 1024);
      const canSegment = this.features.has('REST') && it.size >= segMin * 2 && this.settings.connectionsPerFile > 1;
      if (canSegment) {
        const want = Math.min(this.settings.connectionsPerFile, Math.floor(it.size / segMin)) - 1;
        while (slots - 1 < want && this.sem.tryAcquire(1)) slots++;
      }
      it.connections = slots;
      const fd = await fsp.open(it.localPath, 'w');
      try {
        if (it.size > 0) await fd.truncate(it.size);
        const segs = [];
        if (slots === 1) segs.push({ start: 0, len: it.size, received: 0, done: false, useRest: false });
        else {
          const per = Math.ceil(it.size / slots);
          for (let i = 0; i < slots; i++) {
            const start = i * per; const len = Math.min(per, it.size - start);
            if (len > 0) segs.push({ start, len, received: 0, done: false, useRest: true });
          }
        }
        this.log('transfer', `Download ${it.remotePath} (${fmt(it.size)}) using ${segs.length} connection${segs.length > 1 ? 's' : ''}`);
        // Up to 3 passes: a segment that gave up (e.g. server login cap) is retried once
        // its siblings have finished and freed their connections. The file handle stays
        // open until every segment has settled, so one failure never tears down the rest.
        let lastErr = null;
        for (let pass = 1; pass <= 3 && !it.cancelled; pass++) {
          const pending = segs.filter(sg => !sg.done);
          if (!pending.length) break;
          if (pass > 1) this.log('warn', `${it.name}: retrying ${pending.length} unfinished segment${pending.length > 1 ? 's' : ''} (pass ${pass}/3)`);
          const results = await Promise.allSettled(pending.map(sg => this._downloadSegment(it, sg, fd, segs.indexOf(sg))));
          lastErr = results.find(r => r.status === 'rejected'); lastErr = lastErr ? lastErr.reason : null;
        }
        if (it.cancelled) throw new Error('cancelled');
        if (segs.some(sg => !sg.done)) throw lastErr || new Error('download incomplete');
        it.transferred = it.size;
        it.status = 'done'; it.finished = Date.now();
        const secs = Math.max(0.001, (it.finished - it.started) / 1000);
        this.log('transfer', `Done ${it.name} - ${fmt(it.size)} in ${secs.toFixed(1)}s (${fmt(it.size / secs)}/s)`);
      } finally { await fd.close(); }
    } catch (e) {
      if (it.cancelled) { try { await fsp.unlink(it.localPath); } catch (_) {} if (it.requeue) { it.requeue = false; it.cancelled = false; it.status = 'queued'; } else it.status = 'cancelled'; }
      else { it.status = 'error'; it.error = e.message; this.log('error', `${it.name}: ${e.message}`); }
    } finally { this.sem.release(slots); it.connections = 0; this._dirty(); }
  }

  async _downloadSegment(it, seg, fd, idx) {
    let attempts = 0, busySince = 0;
    while (!seg.done && !it.cancelled) {
      let client;
      try {
        client = await this._newClient();
        it._clients.add(client);
        busySince = 0;
        const c = client;
        const sink = new Writable({
          highWaterMark: 1 << 20,
          write: (chunk, enc, cb) => {
            if (it.cancelled) return cb(new Error('cancelled'));
            const remaining = seg.len - seg.received;
            if (remaining <= 0) { seg.done = true; c.close(); return cb(); }
            const buf = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
            fd.write(buf, 0, buf.length, seg.start + seg.received).then(() => {
              seg.received += buf.length; it.transferred += buf.length; it._bytesTick += buf.length; this.bytesTick += buf.length;
              if (seg.received >= seg.len) { seg.done = true; if (seg.useRest) c.close(); }
              cb();
            }).catch(cb);
          },
        });
        const startAt = seg.start + seg.received;
        await client.downloadTo(sink, it.remotePath, seg.useRest || startAt > 0 ? startAt : 0);
        seg.done = true;
      } catch (e) {
        if (seg.done || it.cancelled) break;
        const msg = e.message || String(e);
        if (isServerBusy(e)) {
          // Server login cap: not a real failure. Learn the cap, then wait for a slot to free up.
          this._onServerBusy();
          if (!busySince) busySince = Date.now();
          const waited = Date.now() - busySince;
          if (waited > 10 * 60 * 1000) throw new Error(`segment ${idx + 1}: server kept refusing new connections for 10 minutes (${msg})`);
          const delay = Math.min(10000, 1500 + Math.random() * 2500 + waited / 20);
          if (waited < 1000) this.log('warn', `${it.name} segment ${idx + 1}: server connection limit reached - waiting for a free slot (offset ${seg.start + seg.received})`);
          await sleep(delay);
          continue;
        }
        attempts++;
        if (attempts > 4) throw new Error(`segment ${idx + 1} failed: ${msg}`);
        this.log('warn', `${it.name} segment ${idx + 1}: ${msg} - retrying (${attempts}/4) from offset ${seg.start + seg.received}`);
        await sleep(1000 * attempts);
      } finally {
        if (client) { it._clients.delete(client); try { client.close(); } catch (_) {} }
      }
    }
  }

  /** Called whenever the server refuses a login for being at its connection cap. */
  _onServerBusy() {
    // A refusal means the server was full. Sample our live data connections a moment
    // later (so in-flight logins have settled); the largest count seen is the real cap.
    if (this._busySampling) return;
    this._busySampling = true;
    setTimeout(() => { this._busySampling = false; this._learnCap(); }, 1500);
  }
  _learnCap() {
    const observed = Math.max(2, this.liveData.size);
    if (this.learnedCap && observed <= this.learnedCap) return;
    this.learnedCap = observed;
    if (observed < this.sem.max) {
      this.sem.setMax(observed);
      this.log('status', `Server limits simultaneous logins - using at most ${observed} connections for this session (Settings > Max total data connections to change).`);
    }
  }

  // ------------------------------------------------------------- upload
  async _upload(it) {
    it.status = 'running'; it.transferred = 0; it.started = Date.now();
    await this.sem.acquire();
    let client;
    try {
      client = await this._newClient();
      it._clients.add(client); it.connections = 1;
      const dir = posix.dirname(it.remotePath);
      if (dir && dir !== '.') await client.ensureDir(dir);
      const src = fs.createReadStream(it.localPath, { highWaterMark: 1 << 20 });
      const counter = new Transform({
        highWaterMark: 1 << 20,
        transform: (b, enc, cb) => { it.transferred += b.length; it._bytesTick += b.length; this.bytesTick += b.length; cb(null, b); },
      });
      src.pipe(counter);
      src.on('error', e => counter.destroy(e));
      this.log('transfer', `Upload ${it.localPath} -> ${it.remotePath} (${fmt(it.size)})`);
      await client.uploadFrom(counter, posix.basename(it.remotePath));
      if (it.cancelled) throw new Error('cancelled');
      it.status = 'done'; it.finished = Date.now();
      const secs = Math.max(0.001, (it.finished - it.started) / 1000);
      this.log('transfer', `Done ${it.name} - ${fmt(it.size)} in ${secs.toFixed(1)}s (${fmt(it.size / secs)}/s)`);
    } catch (e) {
      if (it.cancelled) { if (it.requeue) { it.requeue = false; it.cancelled = false; it.status = 'queued'; } else it.status = 'cancelled'; }
      else { it.status = 'error'; it.error = e.message; this.log('error', `${it.name}: ${e.message}`); }
    } finally {
      if (client) { it._clients.delete(client); try { client.close(); } catch (_) {} }
      this.sem.release(1); it.connections = 0; this._dirty();
    }
  }

  destroy() { clearInterval(this._tick); this.disconnect(); }
}

function isServerBusy(e) {
  const m = (e && e.message) || ''; const code = e && e.code;
  return code === 421 || /^421\b/.test(m) || /maximum|too many (connections|users)|already logged in|connection limit|max(imum)? number of/i.test(m);
}

function fmt(b) {
  if (!b || b < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

// ---------------------------------------------------------------- local fs
async function listLocal(dir) {
  const ents = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const d of ents) {
    const full = path.join(dir, d.name);
    try {
      const st = await fsp.stat(full);
      out.push({ name: d.name, size: st.isDirectory() ? 0 : st.size, type: st.isDirectory() ? 'dir' : 'file', modified: st.mtimeMs });
    } catch (_) { out.push({ name: d.name, size: 0, type: d.isDirectory() ? 'dir' : 'file', modified: null }); }
  }
  return out;
}

async function listDrives() {
  if (process.platform !== 'win32') return ['/'];
  const drives = [];
  for (let i = 65; i <= 90; i++) {
    const d = `${String.fromCharCode(i)}:\\`;
    try { await fsp.access(d); drives.push(d); } catch (_) {}
  }
  return drives;
}

module.exports = { FtpEngine, DEFAULT_SETTINGS, listLocal, listDrives, fmt };
