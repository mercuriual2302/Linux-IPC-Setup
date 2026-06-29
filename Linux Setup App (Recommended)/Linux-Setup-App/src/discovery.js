// src/discovery.js - find Beckhoff CXs by OUI over ARP (network) or NDP (direct link)
const os = require('os');
const net = require('net');
const { exec } = require('child_process');

const BECKHOFF_OUI = '000105';

function normMac(mac) { return String(mac || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase(); }
function isBeckhoff(mac) { return normMac(mac).startsWith(BECKHOFF_OUI); }
function macDisplay(mac) { const n = normMac(mac); return n.length === 12 ? n.match(/.{2}/g).join(':') : mac; }

function ipToInt(ip) {
  const p = ip.split('.').map(n => parseInt(n, 10) & 255);
  return ((p[0] * 16777216) + (p[1] * 65536) + (p[2] * 256) + p[3]) >>> 0;
}
function intToIp(n) {
  n = n >>> 0;
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function execP(cmd) {
  return new Promise(resolve => {
    exec(cmd, { windowsHide: true, timeout: 8000 }, (_err, stdout) => resolve(stdout || ''));
  });
}

// connect primes the ARP cache for in-subnet hosts; result also flags if SSH is up
function tcpProbe(host, port, timeoutMs) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) {} resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

async function pool(items, size, worker) {
  const results = new Array(items.length);
  let i = 0;
  const runners = new Array(Math.min(size, items.length || 1)).fill(0).map(async () => {
    while (i < items.length) { const idx = i++; results[idx] = await worker(items[idx], idx); }
  });
  await Promise.all(runners);
  return results;
}

function classifyAdapters() {
  const ifaces = os.networkInterfaces();
  const routable = [];
  const linkLocal = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    const v4 = addrs.find(a => (a.family === 'IPv4' || a.family === 4) && !a.internal);
    if (!v4) continue;
    if (v4.address.startsWith('169.254.')) {
      const v6 = addrs.find(a => (a.family === 'IPv6' || a.family === 6) && a.address.toLowerCase().startsWith('fe80'));
      linkLocal.push({ name, address: v4.address, netmask: v4.netmask, scopeid: v6 ? v6.scopeid : undefined });
    } else {
      routable.push({ name, address: v4.address, netmask: v4.netmask });
    }
  }
  return { routable, linkLocal };
}

async function readArp() {
  const out = await execP(process.platform === 'win32' ? 'arp -a' : 'ip neigh show');
  const rows = [];
  out.split(/\r?\n/).forEach(line => {
    const m = process.platform === 'win32'
      ? line.match(/^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-fA-F]{2}(?:-[0-9a-fA-F]{2}){5})\s+\w+/)
      : line.match(/^(\d{1,3}(?:\.\d{1,3}){3})\s+dev\s+\S+\s+lladdr\s+([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})/);
    if (m) rows.push({ ip: m[1], mac: m[2] });
  });
  return rows;
}

// ping populates the v6 neighbour table, then read it back
async function readNeighbors6(adapter) {
  if (process.platform === 'win32') {
    await execP(`ping -6 ff02::1%${adapter.scopeid} -n 2`);
    const out = await execP(`netsh interface ipv6 show neighbors interface=${adapter.scopeid}`);
    const rows = [];
    out.split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*(fe80::[0-9a-fA-F:]+)\s+([0-9a-fA-F]{2}(?:-[0-9a-fA-F]{2}){5})\s+\w+/);
      if (m) rows.push({ fe80: m[1], mac: m[2] });
    });
    return rows;
  }
  await execP(`ping -6 -c 2 ff02::1%${adapter.name}`);
  const out = await execP(`ip -6 neigh show dev ${adapter.name}`);
  const rows = [];
  out.split(/\r?\n/).forEach(line => {
    const m = line.match(/^(fe80::[0-9a-fA-F:]+)\s+.*lladdr\s+([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})/);
    if (m) rows.push({ fe80: m[1], mac: m[2] });
  });
  return rows;
}

async function scanNetwork(adapter) {
  const maskInt = ipToInt(adapter.netmask);
  const ipInt = ipToInt(adapter.address);
  const network = (ipInt & maskInt) >>> 0;
  const broadcast = (network | ((~maskInt) >>> 0)) >>> 0;

  let hosts = [];
  for (let n = network + 1; n < broadcast; n++) hosts.push(intToIp(n >>> 0));
  let capped = false;
  if (hosts.length > 1022) { hosts = hosts.slice(0, 1022); capped = true; }
  hosts = hosts.filter(h => h !== adapter.address);

  const open = {};
  await pool(hosts, 64, async (h) => { open[h] = await tcpProbe(h, 22, 800); });

  const arp = await readArp();
  const inSubnet = (ip) => (((ipToInt(ip) & maskInt) >>> 0) === network);

  const devices = [];
  arp.forEach(({ ip, mac }) => {
    if (!isBeckhoff(mac) || !inSubnet(ip)) return;
    devices.push({ type: 'network', ip, mac: macDisplay(mac), iface: adapter.name, ssh: !!open[ip] });
  });
  return { devices, capped };
}

async function scanDirectLink(adapter) {
  const rows = await readNeighbors6(adapter);
  return rows
    .filter(r => isBeckhoff(r.mac))
    .map(r => ({
      type: 'direct',
      mac: macDisplay(r.mac),
      fe80: r.fe80,
      zone: adapter.scopeid !== undefined ? adapter.scopeid : adapter.name,
      iface: adapter.name
    }));
}

async function discoverAll() {
  const { routable, linkLocal } = classifyAdapters();

  const directResults = await Promise.all(linkLocal.map(a => scanDirectLink(a)));
  const netResults = await Promise.all(routable.map(a => scanNetwork(a)));

  const direct = [];
  directResults.forEach(arr => direct.push(...arr));

  let capped = false;
  const netDevices = [];
  netResults.forEach(r => { if (r.capped) capped = true; netDevices.push(...r.devices); });

  const seen = new Set();
  const deduped = [];
  [...direct, ...netDevices].forEach(d => {
    const k = normMac(d.mac);
    if (seen.has(k)) return;
    seen.add(k);
    deduped.push(d);
  });

  return { devices: deduped, capped };
}

module.exports = { classifyAdapters, scanNetwork, scanDirectLink, discoverAll };