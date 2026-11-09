'use strict';
/**
 * VPN awareness. ByteBouncer never handles VPN credentials; it only observes
 * whether a tunnel adapter is up and can launch the official Proton VPN app.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const { execFile } = require('child_process');

const PROTON_RE = /proton/i;
const TUNNEL_RE = /wireguard|wg\d|tun\d*$|tap|openvpn|nordlynx|vpn|mullvad|tailscale|zerotier/i;

function detect() {
  const ifaces = os.networkInterfaces();
  let proton = null, other = null;
  for (const [name, addrs] of Object.entries(ifaces)) {
    const up = (addrs || []).some(a => !a.internal && a.family === 'IPv4' && a.address !== '0.0.0.0');
    if (!up) continue;
    if (PROTON_RE.test(name)) proton = name;
    else if (TUNNEL_RE.test(name) && !/^(eth|en|wlan|wi-?fi|ethernet)/i.test(name)) other = other || name;
  }
  return { connected: !!(proton || other), proton: !!proton, adapter: proton || other || null };
}

function protonPaths() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  return [
    path.join(pf, 'Proton', 'VPN', 'ProtonVPN.Launcher.exe'),
    path.join(pf, 'Proton', 'VPN', 'ProtonVPN.exe'),
    path.join(pf86, 'Proton', 'VPN', 'ProtonVPN.Launcher.exe'),
    path.join(pf, 'Proton Technologies AG', 'ProtonVPN', 'ProtonVPN.exe'),
    path.join(local, 'Programs', 'Proton', 'VPN', 'ProtonVPN.Launcher.exe'),
  ];
}

function openProton() {
  if (process.platform === 'win32') {
    for (const p of protonPaths()) if (fs.existsSync(p)) { execFile(p, [], { detached: true, windowsHide: false }).unref(); return { launched: true, path: p }; }
  }
  shell.openExternal('https://protonvpn.com/download');
  return { launched: false, path: null };
}

class VpnMonitor {
  constructor(onChange, intervalMs = 3000) {
    this.onChange = onChange; this.last = null;
    this.timer = setInterval(() => this.poll(), intervalMs); this.poll();
  }
  poll() {
    const s = detect(); const key = JSON.stringify(s);
    if (key !== this.last) { this.last = key; this.onChange(s); }
    return s;
  }
  stop() { clearInterval(this.timer); }
}

module.exports = { detect, openProton, VpnMonitor };
