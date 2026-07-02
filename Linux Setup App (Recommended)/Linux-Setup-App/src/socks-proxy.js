// src/socks-proxy.js - minimal SOCKS5 server (RFC 1928), CONNECT command only,
// no-auth method only. Hand-rolled rather than a dependency since the protocol
// surface we actually need (apt's socks5h:// proxy mode) is small and well
// specified, and this way there's nothing to trust beyond Node's own net module.
//
// Used to let a CX with no internet route of its own pull packages through this
// laptop's connection. Ephemeral by design - lives only as long as one Setup
// run, nothing is ever written permanently to the CX's apt config.
const net = require('net');

function handleClient(client, sockets) {
  let stage = 'greeting';
  let buf = Buffer.alloc(0);

  client.on('data', (chunk) => {
    if (stage === 'relay') return; // once piping starts, this listener is irrelevant
    buf = Buffer.concat([buf, chunk]);

    if (stage === 'greeting') {
      if (buf.length < 2) return;
      const nmethods = buf[1];
      if (buf.length < 2 + nmethods) return;
      buf = buf.slice(2 + nmethods);
      client.write(Buffer.from([0x05, 0x00])); // version 5, no-auth required
      stage = 'request';
      return;
    }

    if (stage === 'request') {
      if (buf.length < 4) return;
      const cmd = buf[1];
      const atyp = buf[3];
      let addr, port;

      if (atyp === 0x01) { // IPv4
        if (buf.length < 10) return;
        addr = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
        port = buf.readUInt16BE(8);
      } else if (atyp === 0x03) { // domain name - this is the mode apt's socks5h:// actually uses
        const len = buf[4];
        if (buf.length < 5 + len + 2) return;
        addr = buf.slice(5, 5 + len).toString('ascii');
        port = buf.readUInt16BE(5 + len);
      } else {
        client.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); // address type not supported
        return;
      }

      if (cmd !== 0x01) { // CONNECT only - apt has no need for BIND or UDP ASSOCIATE
        client.end(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        return;
      }

      stage = 'relay';
      const upstream = net.connect(port, addr, () => {
        if (sockets) { sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream)); }
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); // success
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on('error', () => {
        try { client.end(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); } catch (_) {}
      });
      client.on('error', () => { try { upstream.destroy(); } catch (_) {} });
    }
  });

  client.on('error', () => {});
}

// Binds to the given adapter address on an ephemeral port (OS-assigned, so
// there's never a "port already in use" failure) and resolves with that port
// once listening. Previously bound 0.0.0.0 with no auth, which made the
// laptop an open proxy on every network it was attached to for the duration
// of a Setup run. Now: bind only the CX-facing adapter, and optionally
// reject any client that isn't the target CX itself.
function normAddr(a) {
  // ::ffff:192.168.1.5 and 192.168.1.5 are the same client
  return String(a || '').replace(/^::ffff:/i, '');
}

function startSocksServer({ bindHost = '127.0.0.1', allowFrom = null } = {}) {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const allowed = Array.isArray(allowFrom) && allowFrom.length
      ? new Set(allowFrom.map(normAddr))
      : null;
    const server = net.createServer((client) => {
      if (allowed && !allowed.has(normAddr(client.remoteAddress))) {
        client.destroy();
        return;
      }
      sockets.add(client);
      client.on('close', () => sockets.delete(client));
      handleClient(client, sockets);
    });
    server._activeSockets = sockets;
    server.on('error', reject);
    server.listen(0, bindHost, () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function stopSocksServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    // close() only stops new connections - unref() detaches from the event
    // loop but leaves existing pipes flowing. Destroy them so "stop" means
    // stopped, not "stops eventually when apt finishes downloading".
    if (server._activeSockets) {
      for (const sock of server._activeSockets) {
        try { sock.destroy(); } catch (_) {}
      }
      server._activeSockets.clear();
    }
    server.close(() => resolve());
  });
}

module.exports = { startSocksServer, stopSocksServer };