'use strict';
/**
 * SFTP (SSH) client exposing the same small surface the engine uses from
 * basic-ftp, so FTP, FTPS and SFTP are interchangeable inside ftp-engine.js.
 */
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const posix = path.posix;

class SftpClient {
  constructor(timeoutMs) {
    this.timeout = timeoutMs; this.conn = null; this.sftp = null; this.closed = false; this.cwd = '/';
    this.ftp = { log: () => {} };
  }
  _p(fn) { return new Promise((res, rej) => fn((err, v) => err ? rej(err) : res(v))); }

  async access(o) {
    const opts = {
      host: o.host, port: Number(o.port) || 22, username: o.user || undefined, readyTimeout: this.timeout, keepaliveInterval: 15000,
      hostVerifier: () => true, algorithms: { compress: ['none'] },
    };
    if (o.keyFile) { opts.privateKey = fs.readFileSync(o.keyFile); if (o.password) opts.passphrase = o.password; }
    else opts.password = o.password || '';
    opts.tryKeyboard = true;
    this.conn = new Client();
    this.conn.on('keyboard-interactive', (n, i, il, prompts, finish) => finish(prompts.map(() => o.password || '')));
    this.conn.on('close', () => { this.closed = true; });
    this.conn.on('error', () => { this.closed = true; });
    this.ftp.log(`Connecting to ${opts.host}:${opts.port} (SSH)`);
    await new Promise((res, rej) => { this.conn.once('ready', res); this.conn.once('error', rej); this.conn.connect(opts); });
    this.sftp = await this._p(cb => this.conn.sftp(cb));
    this.cwd = await this._p(cb => this.sftp.realpath('.', cb));
    this.ftp.log(`< SFTP session opened, home ${this.cwd}`);
    return { code: 220, message: 'ok' };
  }
  features() { return new Map([['REST', 'STREAM'], ['SIZE', ''], ['SFTP', '']]); }
  send() { return Promise.resolve({ code: 200, message: 'ok' }); }
  close() { this.closed = true; if (this._abort) { const a = this._abort; this._abort = null; a(new Error('Client is closed')); } try { this.conn && this.conn.end(); } catch (_) {} }

  _abs(p) { return posix.isAbsolute(p) ? posix.normalize(p) : posix.join(this.cwd, p); }
  async pwd() { return this.cwd; }
  async cd(p) { const a = this._abs(p); const st = await this._p(cb => this.sftp.stat(a, cb)); if (!st.isDirectory()) throw new Error(`${a} is not a directory`); this.cwd = a; }

  async list(p) {
    const a = this._abs(p || '.');
    this.ftp.log(`> LIST ${a}`);
    const rows = await this._p(cb => this.sftp.readdir(a, cb));
    return rows.map(r => {
      const m = r.attrs.mode || 0; const isDir = (m & 0o170000) === 0o040000; const isLink = (m & 0o170000) === 0o120000;
      const perm = n => `${n & 4 ? 'r' : '-'}${n & 2 ? 'w' : '-'}${n & 1 ? 'x' : '-'}`;
      return {
        name: r.filename, size: r.attrs.size || 0, isDirectory: isDir, isSymbolicLink: isLink,
        modifiedAt: r.attrs.mtime ? new Date(r.attrs.mtime * 1000) : undefined, rawModifiedAt: '',
        permissions: { user: perm(m >> 6), group: perm(m >> 3), world: perm(m) },
      };
    });
  }
  async size(p) { const st = await this._p(cb => this.sftp.stat(this._abs(p), cb)); return st.size; }
  async rename(a, b) { return this._p(cb => this.sftp.rename(this._abs(a), this._abs(b), cb)); }
  async remove(p) { return this._p(cb => this.sftp.unlink(this._abs(p), cb)); }
  async removeDir(p) {
    const a = this._abs(p);
    for (const e of await this.list(a)) { const c = posix.join(a, e.name); if (e.isDirectory) await this.removeDir(c); else await this.remove(c); }
    await this._p(cb => this.sftp.rmdir(a, cb));
  }
  async ensureDir(p) {
    const a = this._abs(p); const parts = a.split('/').filter(Boolean); let cur = '/';
    for (const part of parts) {
      cur = posix.join(cur, part);
      try { await this._p(cb => this.sftp.stat(cur, cb)); }
      catch (_) { await this._p(cb => this.sftp.mkdir(cur, cb)); }
    }
    this.cwd = a;
  }

  downloadTo(sink, remotePath, startAt = 0) {
    const a = this._abs(remotePath);
    return new Promise((res, rej) => {
      const rs = this.sftp.createReadStream(a, { start: startAt, highWaterMark: 256 * 1024, autoClose: true });
      this._abort = (e) => { try { rs.destroy(); } catch (_) {} rej(e); };
      rs.on('error', rej); sink.on('error', rej);
      rs.on('end', () => { this._abort = null; sink.end(); });
      sink.on('finish', res);
      rs.pipe(sink, { end: false });
    });
  }
  uploadFrom(source, remotePath) {
    const a = this._abs(remotePath);
    return new Promise((res, rej) => {
      const ws = this.sftp.createWriteStream(a, { highWaterMark: 256 * 1024 });
      ws.on('error', rej); source.on('error', rej);
      ws.on('close', res);
      source.pipe(ws);
    });
  }
}

module.exports = { SftpClient };
