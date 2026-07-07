// src/reachability.js - cheap TCP liveness probe for a CX.
// The app opens a fresh SSH connection per action, so there is no live link
// to check between actions. This gives a quick way to check if sshd is up
// without a full SSH connect.

const net = require('net');

// Connects to host:port. Resolves { open, code }, never rejects.
// code is the socket error (ECONNREFUSED, ETIMEDOUT, etc) on failure.
// Always destroys the socket so probes don't leak handles.
function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (open, code) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (_) {}
      resolve({ open, code: code || null });
    };
    sock.setTimeout(Math.max(1, timeoutMs || 3000));
    sock.once('connect', () => finish(true, null));
    sock.once('timeout', () => finish(false, 'ETIMEDOUT'));
    sock.once('error', (err) => finish(false, (err && err.code) || 'EUNKNOWN'));
    // connect can throw on a bad host/port, guard it too
    try {
      sock.connect(port, host);
    } catch (err) {
      finish(false, (err && err.code) || 'EUNKNOWN');
    }
  });
}

module.exports = { tcpProbe };