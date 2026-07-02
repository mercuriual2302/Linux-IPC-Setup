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

// connect to port 22 and read the SSH banner to determine OS.
// the server sends its banner immediately on connect so no handshake needed.
// for Beckhoff OUI devices: banner containing no "Windows" string = Linux RT image.
function sshBannerProbe(host, timeoutMs) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let done = false;
    let dataTimer = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (dataTimer) clearTimeout(dataTimer);
      try { sock.destroy(); } catch (_) {}
      resolve(result);
    };
    sock.setTimeout(timeoutMs);
    sock.once('timeout', () => finish({ open: false, os: null }));
    sock.once('error',   () => finish({ open: false, os: null }));
    sock.once('connect', () => {
      // if banner doesn't arrive within 400ms, call it open but unknown OS
      dataTimer = setTimeout(() => finish({ open: true, os: 'unknown' }), 400);
      sock.once('data', (chunk) => {
        const banner = chunk.toString('ascii', 0, 128).replace(/[\r\n]+/g, '');
        let os = 'unknown';
        if (/windows/i.test(banner)) os = 'windows';
        else if (banner.startsWith('SSH-')) os = 'linux';
        finish({ open: true, os });
      });
    });
    sock.connect(22, host);
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

  const probes = {};
  await pool(hosts, 64, async (h) => { probes[h] = await sshBannerProbe(h, 800); });

  const arp = await readArp();
  const inSubnet = (ip) => (((ipToInt(ip) & maskInt) >>> 0) === network);

  const devices = [];
  arp.forEach(({ ip, mac }) => {
    if (!isBeckhoff(mac) || !inSubnet(ip)) return;
    const probe = probes[ip] || { open: false, os: null };
    devices.push({ type: 'network', ip, mac: macDisplay(mac), iface: adapter.name, ssh: probe.open, os: probe.os });
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
      iface: adapter.name,
      laptopIp: adapter.address
    }));
}

// ping the 169.254 broadcast to prime ARP, then read the table by MAC.
// if that doesn't work, run an SSH sweep of the whole /16.
// the sweep's TCP probes trigger OS ARP requests for each host as a side effect.
// even when individual probes time out, those ARP entries persist in the OS cache.
// we check ARP one final time after the sweep - this is what catches the CX on first press.
async function resolveDirectLinkIp(mac, laptopIp) {
  const norm = (m) => String(m || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  const target = norm(mac);

  // no -S flag: let Windows route to 169.254.255.255 via the correct adapter
  const pingCmd = process.platform === 'win32'
    ? `ping 169.254.255.255 -n 3 -w 1000`
    : `ping -c 3 -W 1 -b 169.254.255.255`;
  await execP(pingCmd);
  await new Promise(r => setTimeout(r, 400));

  let arp = await readArp();
  let hit = arp.find(e => norm(e.mac) === target);
  if (hit) return hit.ip;

  // broadcast ping alone did not prime ARP (Windows does not always update the ARP
  // cache from unsolicited ICMP broadcast replies). run the sweep, which sends ARP
  // requests for every address it probes. the CX will respond to its own ARP request;
  // that response is cached by the OS even if the TCP connect times out first.
  await scanLinkLocalForSSH(target);

  // this final check is the one that works on first press:
  // the sweep has probed the CX's address, triggering an ARP that is now cached.
  arp = await readArp();
  hit = arp.find(e => norm(e.mac) === target);
  return hit ? hit.ip : null;
}

// scan 169.254.1.1-254.254 for port 22 with high concurrency.
// on a direct link the CX responds in <10ms so this finds it fast.
async function scanLinkLocalForSSH(targetMac) {
  const norm = (m) => String(m || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  const hosts = [];
  // RFC 3927 reserves 169.254.0.x and 169.254.255.x, so the third octet runs
  // 1-254. The fourth octet is a plain host byte in the /16 - 0 and 255 are
  // valid there, and skipping them meant a CX at x.0 or x.255 was never found.
  for (let a = 1; a < 255; a++) for (let b = 0; b <= 255; b++) hosts.push(`169.254.${a}.${b}`);
  // shuffle so average-case performance is O(N/2) regardless of where the CX landed
  for (let i = hosts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [hosts[i], hosts[j]] = [hosts[j], hosts[i]];
  }

  return new Promise((resolve) => {
    let found = null;
    let completed = 0;
    let idx = 0;
    const total = hosts.length;
    // 1500 concurrent sockets could exhaust handles (EMFILE) on some Windows
    // machines - 512 still sweeps the /16 in a few seconds on a direct link
    const CONC = 512;

    function next() {
      if (found || idx >= total) return;
      const host = hosts[idx++];
      tcpProbe(host, 22, 150).then(open => {
        completed++;
        if (open && !found) { found = host; resolve(host); return; }
        if (!found) next();
        if (completed >= total && !found) resolve(null);
      });
    }

    for (let k = 0; k < Math.min(CONC, total); k++) next();
  });
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

module.exports = { classifyAdapters, scanNetwork, scanDirectLink, discoverAll, resolveDirectLinkIp };