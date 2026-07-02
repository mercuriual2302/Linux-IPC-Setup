// main.js - Electron main process
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

const SSHManager = require('./src/ssh-manager');
const ScriptBuilder = require('./src/script-builder');
const discovery = require('./src/discovery');
const sftpManager = require('./src/sftp-manager');
const socksProxy = require('./src/socks-proxy');

// Suppress uncaught ECONNRESET errors - these are expected when the CX drops
// the SSH connection mid-operation (network reload, reboot, poweroff). The
// individual handlers already detect and handle connection drops gracefully;
// without this the raw TCP error bubbles up to Electron and shows a dialog.
process.on('uncaughtException', (err) => {
  if (err && (err.code === 'ECONNRESET' || /ECONNRESET|Connection lost|channel close/i.test(err.message))) return;
  // Surface real bugs without rethrowing - a throw inside this handler kills
  // the process instantly with no dialog. Log it and tell the user instead.
  console.error('[main] Uncaught exception:', err);
  try {
    dialog.showErrorBox('Unexpected error', String((err && err.stack) || err));
  } catch (_) {}
});


// Single instance lock

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

let mainWindow = null;
const activeSessions = new Map(); // sessionId → SSHManager
const shellSessions = new Map(); // sessionId → { mgr, stream } - live PTY sessions for the Shell view
const sftpSessions = new Map(); // sessionId → { mgr, sftp } - persistent SFTP connections for the Files view
let activeProxy = null; // { server, port } - the laptop-as-proxy SOCKS5 server, one at a time, lives only for a Setup run


// Window creation
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 900,
    minWidth: 860,
    minHeight: 700,
    backgroundColor: '#0d1117',
    title: 'Linux Setup Console',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    autoHideMenuBar: true
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Open external links in the user's default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Tear down any active SSH sessions
    for (const mgr of activeSessions.values()) {
      try { mgr.dispose(); } catch (_) {}
    }
    activeSessions.clear();
    // Tear down any live shell sessions
    for (const { mgr, stream } of shellSessions.values()) {
      try { stream.end(); } catch (_) {}
      try { mgr.dispose(); } catch (_) {}
    }
    shellSessions.clear();
    // Tear down any open SFTP sessions
    for (const { mgr } of sftpSessions.values()) {
      try { mgr.dispose(); } catch (_) {}
    }
    sftpSessions.clear();
    // Tear down the laptop-as-proxy SOCKS5 server if one is running
    if (activeProxy) {
      try { activeProxy.server.close(); } catch (_) {}
      activeProxy = null;
    }
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});


// Send event to renderer
function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}


// IPC: test SSH connection
ipcMain.handle('ssh:test', async (_evt, { host, username, password, port }) => {
  const mgr = new SSHManager();
  try {
    await mgr.connect({ host, username, password, port: port || 22 });
    const result = await mgr.exec('uname -a && cat /etc/os-release | head -3');
    mgr.dispose();
    return {
      ok: true,
      output: result.stdout.trim(),
      exitCode: result.code
    };
  } catch (err) {
    mgr.dispose();
    return { ok: false, error: err.message || String(err) };
  }
});


// IPC: fetch available TwinCAT packages from the CX
ipcMain.handle('ssh:fetch-packages', async (_evt, { host, username, password, port }) => {
  const mgr = new SSHManager();
  try {
    await mgr.connect({ host, username, password, port: port || 22 });

    // Match TwinCAT package families: tc<digits>, tf<digits>, te<digits>, plus
    // well-known utility packages (mdp-bhf, adstool, tcusbsrv).
    const cmd =
      `apt-cache search . 2>/dev/null | ` +
      `grep -iE '^(tc[0-9]+|tf[0-9]+|te[0-9]+|mdp-bhf|adstool|tcusbsrv|twincat-)' | ` +
      `sort -u`;

    const result = await mgr.exec(cmd);
    mgr.dispose();

    // Parse "pkgname - description" lines
    const packages = [];
    for (const line of result.stdout.split('\n')) {
      const m = line.match(/^([A-Za-z0-9._+-]+)\s+-\s+(.*)$/);
      if (m) {
        packages.push({ name: m[1].trim(), desc: m[2].trim() });
      }
    }

    return {
      ok: true,
      packages,
      raw: result.stdout,
      count: packages.length
    };
  } catch (err) {
    mgr.dispose();
    return { ok: false, error: err.message || String(err) };
  }
});


// IPC: run setup script live
ipcMain.handle('ssh:run-setup', async (_evt, opts) => {
  const {
    host, username, password, port,
    beckhoffUser, beckhoffPass,
    feed, packages, pkgVersions,
    tf2000Pass, proxyHost, proxyPort
  } = opts;

  const sessionId = `setup-${Date.now()}`;
  const mgr = new SSHManager();
  activeSessions.set(sessionId, mgr);

  sendToRenderer('ssh:status', { sessionId, status: 'connecting', message: `Connecting to ${host}...` });

  try {
    await mgr.connect({ host, username, password, port: port || 22 });
    sendToRenderer('ssh:status', { sessionId, status: 'connected', message: `SSH OK - ${host}` });

    // Generate inner script
    const innerScript = ScriptBuilder.buildInnerSetupScript({
      feed,
      packages,
      pkgVersions,
      tf2000Pass: tf2000Pass || '1',
      proxyHost,
      proxyPort
    });

    // Write locally, upload via SFTP, then exec

    sendToRenderer('ssh:output', { sessionId, data: `\x1b[0;36m[LOCAL]\x1b[0m Uploading setup script to /tmp/twincat_setup.sh\r\n` });

    await withTempScript('tc-setup', innerScript, (p) => mgr.putFile(p, '/tmp/twincat_setup.sh'));

    sendToRenderer('ssh:output', { sessionId, data: `\x1b[0;36m[LOCAL]\x1b[0m Executing on CX - this takes 10-15 minutes. Do not interrupt.\r\n\r\n` });

    const shellEscape = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const runCmd =
      `chmod +x /tmp/twincat_setup.sh && ` +
      `/tmp/twincat_setup.sh ${shellEscape(beckhoffUser || '')} ${shellEscape(beckhoffPass || '')} ${shellEscape(password || '')}`;

    const result = await mgr.execStream(runCmd, {
      onStdout: (chunk) => sendToRenderer('ssh:output', { sessionId, data: chunk.toString() }),
      onStderr: (chunk) => sendToRenderer('ssh:output', { sessionId, data: chunk.toString() })
    });

    // After `sudo reboot` the SSH connection drops. That's expected.
    // If we got an exit code, surface it; if we lost connection, assume reboot.
    const isReboot = !result.code && /Rebooting|Setup complete/i.test(result.stdout + result.stderr);
    sendToRenderer('ssh:status', {
      sessionId,
      status: isReboot || result.code === 0 ? 'complete' : 'failed',
      message: isReboot ? 'CX rebooting - setup complete' : `Exit code ${result.code}`
    });

    mgr.dispose();
    activeSessions.delete(sessionId);
    return { ok: true, sessionId, exitCode: result.code, rebooted: isReboot };

  } catch (err) {
    // SSH may drop as CX reboots - detect that and treat as success
    const msg = String(err.message || err);
    const looksLikeReboot = /ECONNRESET|not connected|Connection lost|Client network socket disconnected/i.test(msg);

    sendToRenderer('ssh:output', { sessionId, data: `\r\n\x1b[1;33m[LOCAL]\x1b[0m Connection closed: ${msg}\r\n` });

    if (looksLikeReboot) {
      sendToRenderer('ssh:output', { sessionId, data: `\x1b[0;32m[LOCAL]\x1b[0m This usually means the CX rebooted successfully. Wait ~40s, then reconnect.\r\n` });
      sendToRenderer('ssh:status', { sessionId, status: 'complete', message: 'CX rebooted (connection dropped as expected)' });
    } else {
      sendToRenderer('ssh:status', { sessionId, status: 'failed', message: msg });
    }

    mgr.dispose();
    activeSessions.delete(sessionId);
    return { ok: looksLikeReboot, sessionId, error: msg, rebooted: looksLikeReboot };
  }
});

// IPC: run TF1200 config live
ipcMain.handle('ssh:run-tf1200', async (_evt, opts) => {
  const { host, username, password, port, hmiUrl, jsonConfig, proxyHost, proxyPort } = opts;

  const sessionId = `tf1200-${Date.now()}`;
  const mgr = new SSHManager();
  activeSessions.set(sessionId, mgr);

  sendToRenderer('ssh:status', { sessionId, status: 'connecting', message: `Connecting to ${host}...` });

  try {
    await mgr.connect({ host, username, password, port: port || 22 });
    sendToRenderer('ssh:status', { sessionId, status: 'connected', message: `SSH OK - ${host}` });

    const innerScript = ScriptBuilder.buildInnerTF1200Script({ jsonConfig, proxyHost, proxyPort });


    sendToRenderer('ssh:output', { sessionId, data: `\x1b[0;36m[LOCAL]\x1b[0m Uploading config script to /tmp/tf1200_configure.sh\r\n` });

    await withTempScript('tc-tf1200', innerScript, (p) => mgr.putFile(p, '/tmp/tf1200_configure.sh'));

    sendToRenderer('ssh:output', { sessionId, data: `\x1b[0;36m[LOCAL]\x1b[0m Applying TF1200 config...\r\n\r\n` });

    const shellEscape = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const runCmd =
      `chmod +x /tmp/tf1200_configure.sh && ` +
      `/tmp/tf1200_configure.sh ${shellEscape(hmiUrl || '')} ${shellEscape(password || '')}`;

    const result = await mgr.execStream(runCmd, {
      onStdout: (chunk) => sendToRenderer('ssh:output', { sessionId, data: chunk.toString() }),
      onStderr: (chunk) => sendToRenderer('ssh:output', { sessionId, data: chunk.toString() })
    });

    const isReboot = !result.code && /Rebooting/i.test(result.stdout + result.stderr);
    sendToRenderer('ssh:status', {
      sessionId,
      status: isReboot || result.code === 0 ? 'complete' : 'failed',
      message: isReboot ? 'CX rebooting - config applied' : `Exit code ${result.code}`
    });

    mgr.dispose();
    activeSessions.delete(sessionId);
    return { ok: true, sessionId, exitCode: result.code, rebooted: isReboot };

  } catch (err) {
    const msg = String(err.message || err);
    const looksLikeReboot = /ECONNRESET|not connected|Connection lost|Client network socket disconnected/i.test(msg);

    sendToRenderer('ssh:output', { sessionId, data: `\r\n\x1b[1;33m[LOCAL]\x1b[0m Connection closed: ${msg}\r\n` });

    if (looksLikeReboot) {
      sendToRenderer('ssh:output', { sessionId, data: `\x1b[0;32m[LOCAL]\x1b[0m CX rebooted after config apply.\r\n` });
      sendToRenderer('ssh:status', { sessionId, status: 'complete', message: 'CX rebooted' });
    } else {
      sendToRenderer('ssh:status', { sessionId, status: 'failed', message: msg });
    }

    mgr.dispose();
    activeSessions.delete(sessionId);
    return { ok: looksLikeReboot, sessionId, error: msg, rebooted: looksLikeReboot };
  }
});


// IPC: cancel a running session

ipcMain.handle('ssh:cancel', async (_evt, { sessionId }) => {
  const mgr = activeSessions.get(sessionId);
  if (!mgr) return { ok: false, error: 'no such session' };
  mgr.dispose();
  activeSessions.delete(sessionId);
  sendToRenderer('ssh:status', { sessionId, status: 'cancelled', message: 'Cancelled by user' });
  return { ok: true };
});


// Live shell - interactive PTY session for the Shell view.
// Opens a real shell channel (not a one-shot exec), streams raw bytes both
// ways so things like vim, top, journalctl -f and sudo prompts work properly.
ipcMain.handle('shell:open', async (_evt, { host, username, password, port, cols, rows }) => {
  const sessionId = `shell-${Date.now()}`;
  const mgr = new SSHManager();
  try {
    await mgr.connect({ host, username: username || 'Administrator', password, port: port || 22 });
    const stream = await mgr.shell({ cols: cols || 80, rows: rows || 24 });
    shellSessions.set(sessionId, { mgr, stream });

    stream.on('data', (chunk) => {
      sendToRenderer('shell:data', { sessionId, chunk });
    });
    if (stream.stderr) {
      stream.stderr.on('data', (chunk) => {
        sendToRenderer('shell:data', { sessionId, chunk });
      });
    }
    stream.on('close', () => {
      sendToRenderer('shell:exit', { sessionId });
      shellSessions.delete(sessionId);
      mgr.dispose();
    });

    return { ok: true, sessionId };
  } catch (err) {
    mgr.dispose();
    return { ok: false, error: err.message || String(err) };
  }
});

// Keystrokes are high-frequency - send/on rather than invoke to skip the
// promise round trip per character.
ipcMain.on('shell:input', (_evt, { sessionId, data }) => {
  const session = shellSessions.get(sessionId);
  if (session && session.stream && session.stream.writable) session.stream.write(data);
});

ipcMain.on('shell:resize', (_evt, { sessionId, cols, rows }) => {
  const session = shellSessions.get(sessionId);
  if (session && session.stream) {
    try { session.stream.setWindow(rows, cols, 0, 0); } catch (_) {}
  }
});

ipcMain.handle('shell:close', async (_evt, { sessionId }) => {
  const session = shellSessions.get(sessionId);
  if (!session) return { ok: false, error: 'no such session' };
  try { session.stream.end(); } catch (_) {}
  session.mgr.dispose();
  shellSessions.delete(sessionId);
  return { ok: true };
});


// Files (SFTP) - one explicit connect opens both the SSH connection and the
// SFTP subsystem on top of it; every list/transfer call for that session
// reuses the same subsystem rather than re-handshaking SFTP per click.
ipcMain.handle('sftp:connect', async (_evt, { host, username, password, port }) => {
  const sessionId = `sftp-${Date.now()}`;
  const mgr = new SSHManager();
  try {
    sendToRenderer('sftp:connect-stage', { stage: 'ssh' });
    await Promise.race([
      mgr.connect({ host, username: username || 'Administrator', password, port: port || 22 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('SSH connection did not complete within 15s.')), 15000))
    ]);
    sendToRenderer('sftp:connect-stage', { stage: 'sftp' });
    // node-ssh's requestSFTP() has no internal timeout - if this hangs here even
    // though a plain `sftp` CLI client connects fine, the bug is in ssh2's SFTP
    // handshake handling specifically, not the CX's sshd config.
    const sftp = await Promise.race([
      mgr.requestSFTP(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(
        'SFTP subsystem did not respond within 10s.'
      )), 10000))
    ]);
    sendToRenderer('sftp:connect-stage', { stage: 'realpath' });
    const startPath = await sftpManager.realpath(sftp, '.');
    sftpSessions.set(sessionId, { mgr, sftp });
    return { ok: true, sessionId, startPath };
  } catch (err) {
    mgr.dispose();
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('sftp:disconnect', async (_evt, { sessionId }) => {
  const s = sftpSessions.get(sessionId);
  if (!s) return { ok: false, error: 'no such session' };
  s.mgr.dispose();
  sftpSessions.delete(sessionId);
  return { ok: true };
});

ipcMain.handle('sftp:list', async (_evt, { sessionId, remotePath }) => {
  const s = sftpSessions.get(sessionId);
  if (!s) return { ok: false, error: 'not connected' };
  try {
    const entries = await sftpManager.listDir(s.sftp, remotePath);
    return { ok: true, entries, path: remotePath };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('sftp:mkdir', async (_evt, { sessionId, remotePath }) => {
  const s = sftpSessions.get(sessionId);
  if (!s) return { ok: false, error: 'not connected' };
  try { await sftpManager.mkdir(s.sftp, remotePath); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message || String(err) }; }
});

ipcMain.handle('sftp:delete', async (_evt, { sessionId, remotePath, isDir }) => {
  const s = sftpSessions.get(sessionId);
  if (!s) return { ok: false, error: 'not connected' };
  try {
    if (isDir) await sftpManager.rmdir(s.sftp, remotePath);
    else await sftpManager.unlink(s.sftp, remotePath);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

ipcMain.handle('sftp:stat', async (_evt, { sessionId, remotePath }) => {
  const s = sftpSessions.get(sessionId);
  if (!s) return { ok: false, exists: false };
  const stats = await sftpManager.stat(s.sftp, remotePath);
  return { ok: true, exists: !!stats };
});

ipcMain.handle('sftp:download', async (_evt, { sessionId, remotePath, localPath, transferId }) => {
  const s = sftpSessions.get(sessionId);
  if (!s) return { ok: false, error: 'not connected' };
  try {
    await s.mgr.sftpDownload(remotePath, localPath, s.sftp, (transferred, total) => {
      sendToRenderer('sftp:progress', { transferId, transferred, total });
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('sftp:upload', async (_evt, { sessionId, localPath, remotePath, transferId }) => {
  const s = sftpSessions.get(sessionId);
  if (!s) return { ok: false, error: 'not connected' };
  try {
    await s.mgr.sftpUpload(localPath, remotePath, s.sftp, (transferred, total) => {
      sendToRenderer('sftp:progress', { transferId, transferred, total });
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// Local side of the file browser - plain Node fs in the main process, no SSH involved
ipcMain.handle('sftp:home-local', async () => {
  return { ok: true, path: os.homedir() };
});

ipcMain.handle('sftp:list-local', async (_evt, { localPath }) => {
  try {
    const target = localPath || os.homedir();
    const names = await fs.promises.readdir(target, { withFileTypes: true });
    const entries = await Promise.all(names.map(async (d) => {
      let size = 0, mtime = 0;
      try {
        const st = await fs.promises.stat(path.join(target, d.name));
        size = st.size; mtime = st.mtimeMs;
      } catch (_) { /* broken symlink or permission denied - list it anyway, zeroed out */ }
      return { name: d.name, type: d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'link' : 'file', size, mtime };
    }));
    return { ok: true, entries, path: target };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('sftp:mkdir-local', async (_evt, { localPath }) => {
  try { await fs.promises.mkdir(localPath); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message || String(err) }; }
});

ipcMain.handle('sftp:delete-local', async (_evt, { localPath, isDir }) => {
  try {
    if (isDir) await fs.promises.rmdir(localPath);
    else await fs.promises.unlink(localPath);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

ipcMain.handle('sftp:stat-local', async (_evt, { localPath }) => {
  try { await fs.promises.stat(localPath); return { ok: true, exists: true }; }
  catch (_) { return { ok: true, exists: false }; }
});

// File preview - text only, size-capped so a huge log or binary doesn't choke the renderer
const MAX_PREVIEW_BYTES = 512 * 1024;
function looksBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) { if (buf[i] === 0) return true; }
  return false;
}

ipcMain.handle('sftp:preview-local', async (_evt, { localPath }) => {
  try {
    const st = await fs.promises.stat(localPath);
    if (st.size > MAX_PREVIEW_BYTES) {
      return { ok: false, error: `File is ${(st.size / 1024).toFixed(0)} KB - too large to preview (limit 512 KB). Download it instead.` };
    }
    const buf = await fs.promises.readFile(localPath);
    if (looksBinary(buf)) return { ok: false, error: "This looks like a binary file and can't be shown as text." };
    return { ok: true, content: buf.toString('utf8') };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('sftp:preview-remote', async (_evt, { sessionId, remotePath }) => {
  const s = sftpSessions.get(sessionId);
  if (!s) return { ok: false, error: 'not connected' };
  try {
    const stats = await sftpManager.stat(s.sftp, remotePath);
    if (stats && stats.size > MAX_PREVIEW_BYTES) {
      return { ok: false, error: `File is ${(stats.size / 1024).toFixed(0)} KB - too large to preview (limit 512 KB). Download it instead.` };
    }
    // reuse the same proven SFTP download path into a scratch temp file, then read it back -
    // avoids writing a second, separately-tested way of pulling bytes off the CX
    const tmpPath = path.join(os.tmpdir(), `lic-preview-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await s.mgr.sftpDownload(remotePath, tmpPath, s.sftp, () => {});
    const buf = await fs.promises.readFile(tmpPath);
    fs.promises.unlink(tmpPath).catch(() => {});
    if (looksBinary(buf)) return { ok: false, error: "This looks like a binary file and can't be shown as text." };
    return { ok: true, content: buf.toString('utf8') };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('sftp:pick-local-dir', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths.length) return { ok: false, cancelled: true };
  return { ok: true, path: res.filePaths[0] };
});

// Generic path helpers so the renderer never has to guess Windows vs POSIX
// separators for the local pane - Node's path module always gets it right.
ipcMain.handle('fs:join', (_evt, { base, name }) => ({ ok: true, path: path.join(base, name) }));
ipcMain.handle('fs:dirname', (_evt, { p }) => ({ ok: true, path: path.dirname(p) }));


// Internet-access check before a Setup run - bash's /dev/tcp pseudo-device
// needs no extra tools on the CX (no curl/wget dependency), just bash itself.
ipcMain.handle('cx:check-internet', async (_evt, { host, username, password, port }) => {
  const mgr = new SSHManager();
  try {
    await mgr.connect({ host, username: username || 'Administrator', password, port: port || 22 });
    const result = await mgr.exec(`timeout 5 bash -c 'cat < /dev/null > /dev/tcp/deb.beckhoff.com/443' && echo REACHABLE || echo UNREACHABLE`);
    mgr.dispose();
    return { ok: true, reachable: /REACHABLE/.test(result.stdout) && !/UNREACHABLE/.test(result.stdout) };
  } catch (err) {
    mgr.dispose();
    return { ok: false, error: err.message || String(err) };
  }
});

// Start the laptop-as-proxy SOCKS5 server for one Setup run. Determines which
// of this laptop's addresses is actually reachable by the CX with a throwaway
// TCP probe to its SSH port - lets the OS routing table answer that instead of
// us guessing which adapter is the right one.
ipcMain.handle('proxy:start', async (_evt, { host, port }) => {
  try {
    // which of this laptop's addresses the CX can actually reach - redone every
    // call since a different target CX may sit on a different adapter/subnet,
    // even though the SOCKS server itself is a singleton reused across targets.
    const localAddress = await new Promise((resolve, reject) => {
      const probe = net.connect(port || 22, host, () => {
        const addr = probe.localAddress;
        probe.destroy();
        resolve(addr);
      });
      probe.on('error', reject);
    });
    // If a proxy is already running but bound to a different adapter (a new
    // target CX on another subnet), tear it down and rebind on the right one
    if (activeProxy && activeProxy.host !== localAddress) {
      await socksProxy.stopSocksServer(activeProxy.server);
      activeProxy = null;
    }
    if (!activeProxy) {
      const { server, port: proxyPort } = await socksProxy.startSocksServer({
        bindHost: localAddress,
        allowFrom: [host]
      });
      activeProxy = { server, port: proxyPort, host: localAddress };
    }
    return { ok: true, proxyHost: localAddress, proxyPort: activeProxy.port };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('proxy:stop', async () => {
  if (activeProxy) {
    await socksProxy.stopSocksServer(activeProxy.server);
    activeProxy = null;
  }
  return { ok: true };
});


// IPC: save generated script to disk (replaces the in-browser download)
ipcMain.handle('script:save', async (_evt, { content, defaultName }) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Save shell script',
    defaultPath: defaultName || 'twincat_setup.sh',
    filters: [{ name: 'Shell Script', extensions: ['sh'] }, { name: 'All Files', extensions: ['*'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false, cancelled: true };
  await fs.promises.writeFile(res.filePath, content, { mode: 0o755 });
  return { ok: true, path: res.filePath };
});


// IPC: generate scripts for preview/copy
ipcMain.handle('script:build-setup', async (_evt, opts) => {
  return { ok: true, script: ScriptBuilder.buildFullSetupScript(opts) };
});

ipcMain.handle('script:build-tf1200', async (_evt, opts) => {
  return { ok: true, script: ScriptBuilder.buildFullTF1200Script(opts) };
});
//Skibidi end 67 big chungus


// CX management IPC handlers


// Run a short command and return full output
async function sshExec(opts, cmd) {
  const mgr = new SSHManager();
  await mgr.connect({ host: opts.host, username: opts.username || 'Administrator', password: opts.password, port: opts.port || 22 });
  const result = await mgr.exec(cmd);
  mgr.dispose();
  return result;
}

// Run a command and stream output to the terminal tab
async function sshStream(sessionId, opts, cmd) {
  const mgr = new SSHManager();
  activeSessions.set(sessionId, mgr);
  sendToRenderer('ssh:status', { sessionId, status: 'connecting', message: `Connecting to ${opts.host}...` });
  await mgr.connect({ host: opts.host, username: opts.username || 'Administrator', password: opts.password, port: opts.port || 22 });
  sendToRenderer('ssh:status', { sessionId, status: 'connected', message: `SSH OK - ${opts.host}` });
  const result = await mgr.execStream(cmd, {
    onStdout: (chunk) => sendToRenderer('ssh:output', { sessionId, data: chunk.toString() }),
    onStderr: (chunk) => sendToRenderer('ssh:output', { sessionId, data: chunk.toString() })
  });
  mgr.dispose();
  activeSessions.delete(sessionId);
  return result;
}

// Validators for values that end up inside generated shell scripts.
// Anything that fails these never reaches a template literal.
const IPV4_RE  = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IFACE_RE = /^[A-Za-z0-9._-]{1,32}$/;
const UNIT_RE  = /^[A-Za-z0-9:._@-]{1,128}$/;

// Write a script to a local temp file, hand the path to fn (usually putFile),
// and always delete the temp file - even when connect/putFile throws. The old
// inline pattern left password-bearing scripts in %TEMP% on any error before
// the unlink line. Mode 0600: only this user needs to read it, and the exec
// bit is set on the CX side by chmod +x, not here.
async function withTempScript(prefix, content, fn) {
  const tmpPath = path.join(os.tmpdir(), `${prefix}-${Date.now()}.sh`);
  await fs.promises.writeFile(tmpPath, content, { mode: 0o600 });
  try {
    return await fn(tmpPath);
  } finally {
    await fs.promises.unlink(tmpPath).catch(() => {});
  }
}


// MyBeckhoff credential validator
// Uses curl on the CX to check credentials against the Beckhoff APT repo.
// Returns in under 3 seconds - no apt update needed.
ipcMain.handle('cx:validate-creds', async (_evt, { host, password, port, beckhoffUser, beckhoffPass, proxyHost, proxyPort }) => {
  const esc = (s) => (s || '').replace(/'/g, "'\\''");
  const proxyFlag = (proxyHost && proxyPort) ? `-x socks5h://${proxyHost}:${proxyPort} ` : '';
  // curl a known Beckhoff InRelease file with basic auth - 200 = valid, 401 = bad creds
  const cmd = `curl -s -o /dev/null -w "%{http_code}" --max-time 10 ${proxyFlag}` +
    `--user '${esc(beckhoffUser)}:${esc(beckhoffPass)}' ` +
    `https://deb.beckhoff.com/debian/dists/trixie-stable/InRelease`;
  try {
    const mgr = new SSHManager();
    await mgr.connect({ host, username: 'Administrator', password, port: port || 22 });
    const result = await mgr.exec(cmd);
    mgr.dispose();
    const code = (result.stdout || '').trim();
    if (code === '200') return { ok: true };
    if (code === '401' || code === '403') return { ok: false, error: 'Invalid MyBeckhoff credentials (server returned ' + code + ')' };
    if (code === '000') return { ok: false, error: 'Could not reach deb.beckhoff.com - check CX network/internet' };
    return { ok: false, error: 'Unexpected response: HTTP ' + (code || 'timeout') };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Network configurator
ipcMain.handle('cx:network', async (_evt, opts) => {
  // opts: { host, password, iface, mode:'dhcp'|'static', ip, prefix, gateway, dns }
  const { host, password, port, iface = 'end0', mode, ip, prefix = '24', gateway, dns = '8.8.8.8' } = opts;
  const sessionId = `net-${Date.now()}`;

  // Everything below is interpolated into a shell script - validate first
  if (!IFACE_RE.test(iface)) return { ok: false, error: `Invalid interface name: ${iface}` };
  const pfx = parseInt(prefix, 10);
  if (mode !== 'dhcp') {
    if (!IPV4_RE.test(ip || '')) return { ok: false, error: `Invalid IP address: ${ip}` };
    if (!Number.isInteger(pfx) || pfx < 0 || pfx > 32 || String(pfx) !== String(prefix).trim()) {
      return { ok: false, error: `Invalid prefix: ${prefix}` };
    }
    if (gateway && !IPV4_RE.test(gateway)) return { ok: false, error: `Invalid gateway: ${gateway}` };
    if (!IPV4_RE.test(dns)) return { ok: false, error: `Invalid DNS address: ${dns}` };
  }

  const sudoLine = `_sudo() { echo "$SUDO_PASS" | sudo -S -p '' "$@"; }`;
  let script;

  if (mode === 'dhcp') {
    script = `#!/bin/bash
set -e
SUDO_PASS='${password.replace(/'/g, "'\\''")}'
${sudoLine}
_sudo -v
IFACE="${iface}"
FILE="/etc/systemd/network/10-\${IFACE}.network"
trap 'rm -f "$0"' EXIT
echo "[CX] Writing DHCP config for \$IFACE..."
TMP=$(mktemp)
printf '[Match]\nName=%s\n\n[Network]\nDHCP=yes\n' "\$IFACE" > "\$TMP"
_sudo mv "\$TMP" "\$FILE"
_sudo chmod 644 "\$FILE"
echo "[CX] Reloading networkd..."
_sudo networkctl reload || _sudo systemctl restart systemd-networkd
echo "[CX] Network set to DHCP on \$IFACE. Changes take effect immediately."
`;
  } else {
    script = `#!/bin/bash
set -e
SUDO_PASS='${password.replace(/'/g, "'\\''")}'
${sudoLine}
_sudo -v
IFACE="${iface}"
FILE="/etc/systemd/network/10-\${IFACE}.network"
trap 'rm -f "$0"' EXIT
echo "[CX] Writing static IP config for \$IFACE..."
TMP=$(mktemp)
printf '[Match]\nName=%s\n\n[Network]\nAddress=%s/%s\n' "\$IFACE" "${ip}" "${prefix}" > "\$TMP"
${gateway ? `printf 'Gateway=%s\\n' "${gateway}" >> "\$TMP"` : `echo "# No gateway configured"`}
printf 'DNS=%s\n' "${dns}" >> "\$TMP"
_sudo mv "\$TMP" "\$FILE"
_sudo chmod 644 "\$FILE"
echo "[CX] Reloading networkd..."
_sudo networkctl reload || _sudo systemctl restart systemd-networkd
echo "[CX] Static IP ${ip}/${prefix} applied to \$IFACE."
echo "[CX] Gateway: ${gateway || 'none'}  DNS: ${dns}"
`;
  }

  try {
    sendToRenderer('ssh:output', { sessionId, data: `\x1b[0;36m[LOCAL]\x1b[0m Applying network config...\r\n` });
    const mgr = new SSHManager();
    activeSessions.set(sessionId, mgr);
    await mgr.connect({ host, username: 'Administrator', password, port: port || 22 });
    await withTempScript('cx-net', script, (p) => mgr.putFile(p, '/tmp/cx_network.sh'));
    const result = await mgr.execStream('chmod +x /tmp/cx_network.sh && /tmp/cx_network.sh', {
      onStdout: (c) => sendToRenderer('ssh:output', { sessionId, data: c.toString() }),
      onStderr: (c) => sendToRenderer('ssh:output', { sessionId, data: c.toString() })
    });
    mgr.dispose();
    activeSessions.delete(sessionId);
    sendToRenderer('ssh:status', { sessionId, status: result.code === 0 ? 'complete' : 'failed', message: result.code === 0 ? 'Network config applied - connection may drop if IP changed' : `Exit ${result.code}` });
    return { ok: result.code === 0, sessionId };
  } catch (err) {
    const msg = String(err.message || err);
    const looksLikeReload = /ECONNRESET|not connected|Connection lost|Client network socket disconnected/i.test(msg);
    if (looksLikeReload) {
      sendToRenderer('ssh:output', { sessionId, data: `\r\n\x1b[0;32m[LOCAL]\x1b[0m Connection dropped - this is expected when the IP changes. Config was applied.\r\n` });
      sendToRenderer('ssh:status', { sessionId, status: 'complete', message: 'Network config applied (connection dropped as expected)' });
      return { ok: true, sessionId };
    }
    sendToRenderer('ssh:status', { sessionId, status: 'failed', message: msg });
    return { ok: false, error: msg };
  }
});

// Firewall manager
ipcMain.handle('cx:firewall', async (_evt, opts) => {
  // opts: { host, password, port, enable:bool, ports:[{port,proto,label,open}] }
  const { host, password, port, enable, ports = [] } = opts;
  const sessionId = `fw-${Date.now()}`;

  // Validate everything that reaches the script - port must be a real port,
  // proto is forced to tcp/udp, label is stripped to a safe comment charset
  const cleanPorts = [];
  for (const p of ports) {
    if (!p || !p.open) continue;
    const portNum = parseInt(p.port, 10);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return { ok: false, error: `Invalid port: ${p.port}` };
    }
    const proto = p.proto === 'udp' ? 'udp' : 'tcp';
    const label = String(p.label || '').replace(/[^A-Za-z0-9 ._/-]/g, '').slice(0, 40);
    cleanPorts.push({ port: portNum, proto, label });
  }
  const openRules = cleanPorts.map(p =>
    `_sudo nft add rule inet filter input ${p.proto} dport ${p.port} accept  # ${p.label}`
  ).join('\n');

  const script = `#!/bin/bash
set -e
SUDO_PASS='${password.replace(/'/g, "'\\''")}'
_sudo() { echo "$SUDO_PASS" | sudo -S -p '' "$@"; }
_sudo -v
trap 'rm -f "$0"' EXIT

${enable ? `echo "[CX] Configuring nftables firewall..."
_sudo nft flush ruleset
_sudo nft add table inet filter
_sudo nft add chain inet filter input '{ type filter hook input priority 0; policy drop; }'
_sudo nft add chain inet filter forward '{ type filter hook forward priority 0; policy drop; }'
_sudo nft add chain inet filter output '{ type filter hook output priority 0; policy accept; }'
# Always allow established/related and loopback
_sudo nft add rule inet filter input ct state established,related accept
_sudo nft add rule inet filter input iif lo accept
# SSH port 22 is always open - hardcoded, cannot be blocked via the UI
_sudo nft add rule inet filter input tcp dport 22 accept
${openRules}
_sudo systemctl enable nftables
_sudo systemctl start nftables
_sudo nft list ruleset | _sudo tee /etc/nftables.conf
echo "[CX] Firewall enabled with selected ports open."` :
`echo "[CX] Disabling nftables firewall..."
_sudo systemctl stop nftables || true
_sudo systemctl disable nftables || true
_sudo nft flush ruleset || true
echo "[CX] Firewall disabled - all ports open."`}
`;

  try {
    const mgr = new SSHManager();
    activeSessions.set(sessionId, mgr);
    await mgr.connect({ host, username: 'Administrator', password, port: port || 22 });
    await withTempScript('cx-fw', script, (p) => mgr.putFile(p, '/tmp/cx_firewall.sh'));
    const result = await mgr.execStream('chmod +x /tmp/cx_firewall.sh && /tmp/cx_firewall.sh', {
      onStdout: (c) => sendToRenderer('ssh:output', { sessionId, data: c.toString() }),
      onStderr: (c) => sendToRenderer('ssh:output', { sessionId, data: c.toString() })
    });
    mgr.dispose();
    activeSessions.delete(sessionId);
    sendToRenderer('ssh:status', { sessionId, status: result.code === 0 ? 'complete' : 'failed', message: result.code === 0 ? 'Firewall config applied' : `Exit ${result.code}` });
    return { ok: result.code === 0, sessionId };
  } catch (err) {
    sendToRenderer('ssh:status', { sessionId, status: 'failed', message: err.message });
    return { ok: false, error: err.message };
  }
});

// Password changer
ipcMain.handle('cx:passwd', async (_evt, opts) => {
  // opts: { host, password, port, targetUser, newPassword }
  const { host, password, port, targetUser, newPassword } = opts;
  const sessionId = `passwd-${Date.now()}`;

  // User-supplied values travel as base64 (injection-safe), matching cx:user-mgmt
  const b64 = (s) => Buffer.from(String(s == null ? '' : s), 'utf8').toString('base64');
  const script = `#!/bin/bash
set -e
trap 'rm -f "$0"' EXIT
SUDO_PASS='${password.replace(/'/g, "'\\''")}'
_sudo() { echo "$SUDO_PASS" | sudo -S -p '' "$@"; }
_sudo -v
TARGET="$(printf '%s' '${b64(targetUser)}' | base64 -d)"
NEW_PASS="$(printf '%s' '${b64(newPassword)}' | base64 -d)"
echo "[CX] Changing password for user: $TARGET"
_sudo sh -c 'printf "%s:%s\\n" "$1" "$2" | chpasswd' _ "$TARGET" "$NEW_PASS"
echo "[CX] Password changed successfully for $TARGET."
`;

  try {
    const mgr = new SSHManager();
    activeSessions.set(sessionId, mgr);
    await mgr.connect({ host, username: 'Administrator', password, port: port || 22 });
    await withTempScript('cx-passwd', script, (p) => mgr.putFile(p, '/tmp/cx_passwd.sh'));
    const result = await mgr.execStream('chmod +x /tmp/cx_passwd.sh && /tmp/cx_passwd.sh', {
      onStdout: (c) => sendToRenderer('ssh:output', { sessionId, data: c.toString() }),
      onStderr: (c) => sendToRenderer('ssh:output', { sessionId, data: c.toString() })
    });
    mgr.dispose();
    activeSessions.delete(sessionId);
    sendToRenderer('ssh:status', { sessionId, status: result.code === 0 ? 'complete' : 'failed', message: result.code === 0 ? `Password changed for ${targetUser}` : `Exit ${result.code}` });
    return { ok: result.code === 0, sessionId };
  } catch (err) {
    sendToRenderer('ssh:status', { sessionId, status: 'failed', message: err.message });
    return { ok: false, error: err.message };
  }
});


// Package update checker
ipcMain.handle('cx:fetch-updates', async (_evt, opts) => {
  const { host, password, port, checkUpdates } = opts;
  try {
    if (checkUpdates) {
      // Run apt update then list upgradable TwinCAT packages
      const pw = (password || '').replace(/'/g, "'\\''");
      const result = await sshExec({ host, password, port },
        `echo '${pw}' | sudo -S -p '' apt-get update -qq 2>/dev/null; ` +
        `apt list --upgradable 2>/dev/null | grep -v '^Listing'`
      );
      const updates = [];
      for (const line of result.stdout.split('\n')) {
        const m = line.match(/^([^\s/]+)\//);
        if (m && /^(tc[0-9]|tf[0-9]|te[0-9]|mdp-bhf|adstool|tcusbsrv)/i.test(m[1])) {
          const verMatch = line.match(/^\S+\s+(\S+)\s+\S+\s+\[upgradable from: (\S+)\]/);
          updates.push({ name: m[1], newVer: verMatch ? verMatch[1] : '?', oldVer: verMatch ? verMatch[2] : '?' });
        }
      }
      return { ok: true, updates, count: updates.length };
    } else {
      // List all installed TwinCAT/Beckhoff packages via dpkg-query
      const result = await sshExec({ host, password, port },
        `dpkg-query -W -f='\${Package}\t\${Version}\t\${db:Status-Status}\n' 2>/dev/null`
      );
      const packages = [];
      for (const line of result.stdout.split('\n')) {
        const parts = line.split('\t');
        if (parts.length >= 3 && /^(tc[0-9]|tf[0-9]|te[0-9]|mdp-bhf|adstool|tcusbsrv)/i.test(parts[0]) && parts[2].trim() === 'installed') {
          packages.push({ name: parts[0].trim(), version: parts[1].trim(), upgradable: false, newVer: '' });
        }
      }
      return { ok: true, packages, count: packages.length };
    }
  } catch (err) {
    return { ok: false, error: err.message, packages: [], updates: [] };
  }
});

// Run apt upgrade
ipcMain.handle('cx:upgrade', async (_evt, opts) => {
  const { host, password, port, packages } = opts;
  const sessionId = `upgrade-${Date.now()}`;
  const script = `#!/bin/bash
set -e
export TERM=dumb
export DEBIAN_FRONTEND=noninteractive
APT_OPTS='-o Dpkg::Progress-Fancy=0 -o Dpkg::Use-Pty=0 -o APT::Color=0 -o Quiet::NoUpdate=true'
SUDO_PASS='${password.replace(/'/g, "'\\''")}'
_sudo() { echo "$SUDO_PASS" | sudo -S -p '' "$@"; }
_sudo -v
trap 'rm -f "$0"' EXIT
echo "[CX] Running apt update..."
_sudo apt $APT_OPTS update -y
echo "[CX] Running upgrade..."
_sudo apt $APT_OPTS install -y --only-upgrade ${(packages && packages.length ? packages.join(" ") : "$(apt list --upgradable 2>/dev/null | grep -v Listing | cut -d/ -f1 | tr '\\n' ' ')")}
echo "[CX] Upgrade complete."
`;
  try {
    const mgr = new SSHManager();
    activeSessions.set(sessionId, mgr);
    sendToRenderer('ssh:output', { sessionId, data: `\x1b[0;36m[LOCAL]\x1b[0m Starting upgrade on ${host}...\r\n` });
    await mgr.connect({ host, username: 'Administrator', password, port: port || 22 });
    await withTempScript('cx-upgrade', script, (p) => mgr.putFile(p, '/tmp/cx_upgrade.sh'));
    const result = await mgr.execStream('chmod +x /tmp/cx_upgrade.sh && /tmp/cx_upgrade.sh', {
      onStdout: (c) => sendToRenderer('ssh:output', { sessionId, data: c.toString() }),
      onStderr: (c) => sendToRenderer('ssh:output', { sessionId, data: c.toString() })
    });
    mgr.dispose();
    activeSessions.delete(sessionId);
    sendToRenderer('ssh:status', { sessionId, status: result.code === 0 ? 'complete' : 'failed', message: result.code === 0 ? 'Upgrade complete' : `Exit ${result.code}` });
    return { ok: result.code === 0, sessionId };
  } catch (err) {
    sendToRenderer('ssh:status', { sessionId, status: 'failed', message: err.message });
    return { ok: false, error: err.message };
  }
});

// Post-install verification
ipcMain.handle('cx:verify', async (_evt, opts) => {
  const { host, password, port, packages = [] } = opts;
  const sessionId = `verify-${Date.now()}`;

  // Build per-package check lines
  const pkgChecks = ['tc31-xar-um', ...packages].map(p =>
    `PKG="${p}"; STATUS=$(dpkg -l "$PKG" 2>/dev/null | grep "^ii" | wc -l); ` +
    `[ "$STATUS" -gt 0 ] && echo "PASS:$PKG" || echo "FAIL:$PKG"`
  ).join('\n');

  // Service checks
  const services = ['tc31-xar'];
  if (packages.includes('tf2000-hmi-server')) services.push('TcHmiSrv');
  const svcChecks = services.map(s =>
    `SVC="${s}"; ST=$(systemctl is-active "$SVC" 2>/dev/null || echo inactive); ` +
    `[ "$ST" = "active" ] && echo "SVC_PASS:$SVC" || echo "SVC_FAIL:$SVC:$ST"`
  ).join('\n');

  const script = `#!/bin/bash
SUDO_PASS='${password.replace(/'/g, "'\\''")}'
_sudo() { echo "$SUDO_PASS" | sudo -S -p '' "$@"; }
_sudo -v 2>/dev/null
trap 'rm -f "$0"' EXIT
echo "=== PACKAGE VERIFICATION ==="
${pkgChecks}
echo "=== SERVICE STATUS ==="
${svcChecks}
echo "=== SYSTEM INFO ==="
echo "DISK:$(df -h / | awk 'NR==2{print $3\"/\"$2\" (\"$5\" used)\"}')"
echo "MEM:$(free -m | awk 'NR==2{printf \"%dMB / %dMB\", $3, $2}')"
echo "UPTIME:$(uptime -p)"
echo "KERNEL:$(uname -r)"
echo "=== END ==="
`;

  try {
    const mgr = new SSHManager();
    activeSessions.set(sessionId, mgr);
    sendToRenderer('ssh:output', { sessionId, data: `\x1b[0;36m[LOCAL]\x1b[0m Running post-install verification...\r\n\r\n` });
    await mgr.connect({ host, username: 'Administrator', password, port: port || 22 });
    await withTempScript('cx-verify', script, (p) => mgr.putFile(p, '/tmp/cx_verify.sh'));

    const rawLines = [];
    const result = await mgr.execStream('chmod +x /tmp/cx_verify.sh && /tmp/cx_verify.sh', {
      onStdout: (c) => {
        const str = c.toString();
        rawLines.push(str);
        sendToRenderer('ssh:output', { sessionId, data: str });
      },
      onStderr: (c) => sendToRenderer('ssh:output', { sessionId, data: c.toString() })
    });
    mgr.dispose();
    activeSessions.delete(sessionId);

    // Parse results
    const raw = rawLines.join('');
    const pkgResults = [];
    const svcResults = [];
    let sysInfo = {};
    for (const line of raw.split('\n')) {
      if (line.startsWith('PASS:')) pkgResults.push({ name: line.slice(5), ok: true });
      else if (line.startsWith('FAIL:')) pkgResults.push({ name: line.slice(5), ok: false });
      else if (line.startsWith('SVC_PASS:')) svcResults.push({ name: line.slice(9), ok: true, status: 'active' });
      else if (line.startsWith('SVC_FAIL:')) { const p = line.slice(9).split(':'); svcResults.push({ name: p[0], ok: false, status: p[1] || 'inactive' }); }
      else if (line.startsWith('DISK:')) sysInfo.disk = line.slice(5);
      else if (line.startsWith('MEM:')) sysInfo.mem = line.slice(4);
      else if (line.startsWith('UPTIME:')) sysInfo.uptime = line.slice(7);
      else if (line.startsWith('KERNEL:')) sysInfo.kernel = line.slice(7);
    }

    sendToRenderer('ssh:status', { sessionId, status: 'complete', message: 'Verification complete' });
    return { ok: true, sessionId, pkgResults, svcResults, sysInfo };
  } catch (err) {
    sendToRenderer('ssh:status', { sessionId, status: 'failed', message: err.message });
    return { ok: false, error: err.message };
  }
});

// Power management - shutdown, restart, TC runtime restart
ipcMain.handle('cx:power', async (_evt, opts) => {
  // opts: { host, password, port, action: 'shutdown' | 'restart' | 'tc-restart' }
  const { host, password, port, action } = opts;
  const sessionId = `power-${Date.now()}`;

  const escPass = String(password || '').replace(/'/g, "'\\''");
  const _sudo = `echo '${escPass}' | sudo -S -p ''`;

  let cmd, label, expectDrop;
  if (action === 'shutdown') {
    cmd = `${_sudo} systemctl poweroff`;
    label = 'Powering off the CX';
    expectDrop = true;
  } else if (action === 'restart') {
    cmd = `${_sudo} systemctl reboot`;
    label = 'Rebooting the CX';
    expectDrop = true;
  } else if (action === 'tc-restart') {
    // Restart only the TwinCAT 3 runtime - the SSH session stays up.
    // The live target image runs the runtime as TcSystemServiceUm; other images
    // use tc31-xar, so try the first and fall back to the second.
    cmd = `${_sudo} bash -c "systemctl restart TcSystemServiceUm 2>/dev/null || systemctl restart tc31-xar; systemctl is-active TcSystemServiceUm 2>/dev/null || systemctl is-active tc31-xar"`;
    label = 'Restarting the TwinCAT runtime';
    expectDrop = false;
  } else {
    return { ok: false, error: `Unknown power action: ${action}` };
  }

  const mgr = new SSHManager();
  activeSessions.set(sessionId, mgr);
  sendToRenderer('ssh:status', { sessionId, status: 'connecting', message: `Connecting to ${host}...` });

  try {
    await mgr.connect({ host, username: 'Administrator', password, port: port || 22 });
    sendToRenderer('ssh:status', { sessionId, status: 'connected', message: `SSH OK - ${host}` });
    sendToRenderer('ssh:output', { sessionId, data: `\x1b[0;36m[LOCAL]\x1b[0m ${label}...\r\n` });

    const result = await mgr.execStream(cmd, {
      onStdout: (c) => sendToRenderer('ssh:output', { sessionId, data: c.toString() }),
      onStderr: (c) => sendToRenderer('ssh:output', { sessionId, data: c.toString() })
    });

    mgr.dispose();
    activeSessions.delete(sessionId);

    if (expectDrop) {
      // poweroff/reboot can return cleanly OR sever the link first - both mean success
      const msg = action === 'shutdown' ? 'CX is powering off' : 'CX is rebooting';
      sendToRenderer('ssh:output', { sessionId, data: `\x1b[0;32m[LOCAL]\x1b[0m ${msg}.\r\n` });
      sendToRenderer('ssh:status', { sessionId, status: 'complete', message: msg });
      return { ok: true, sessionId, action, rebooted: action === 'restart' };
    }

    const ok = result.code === 0;
    sendToRenderer('ssh:status', {
      sessionId,
      status: ok ? 'complete' : 'failed',
      message: ok ? 'TwinCAT runtime restarted' : `TwinCAT runtime not active (exit ${result.code})`
    });
    return { ok, sessionId, action };

  } catch (err) {
    const msg = String(err.message || err);
    const looksLikeDrop = /ECONNRESET|not connected|Connection lost|Client network socket disconnected|ETIMEDOUT|channel close/i.test(msg);
    mgr.dispose();
    activeSessions.delete(sessionId);

    if (expectDrop && looksLikeDrop) {
      const okMsg = action === 'shutdown'
        ? 'CX powering off (connection dropped as expected)'
        : 'CX rebooting (connection dropped as expected)';
      sendToRenderer('ssh:output', { sessionId, data: `\r\n\x1b[0;32m[LOCAL]\x1b[0m ${okMsg}\r\n` });
      sendToRenderer('ssh:status', { sessionId, status: 'complete', message: okMsg });
      return { ok: true, sessionId, action, rebooted: action === 'restart' };
    }

    sendToRenderer('ssh:output', { sessionId, data: `\r\n\x1b[1;33m[LOCAL]\x1b[0m ${msg}\r\n` });
    sendToRenderer('ssh:status', { sessionId, status: 'failed', message: msg });
    return { ok: false, sessionId, action, error: msg };
  }
});

// User management - list accounts
ipcMain.handle('cx:users-list', async (_evt, opts) => {
  const { host, password, port } = opts || {};
  const escPass = String(password || '').replace(/'/g, "'\\''");
  const script = `#!/bin/bash
SUDO_PASS='${escPass}'
_sudo() { echo "$SUDO_PASS" | sudo -S -p '' "$@"; }
_sudo -v 2>/dev/null || true
SUDOERS=",$(getent group sudo | cut -d: -f4),"
while IFS=: read -r name _ uid _ _ home _; do
  if [ "$uid" -ge 1000 ] && [ "$uid" -lt 65534 ]; then
    insudo=0; case "$SUDOERS" in *",$name,"*) insudo=1;; esac
    st="$(_sudo passwd -S "$name" 2>/dev/null | awk '{print $2}')"
    locked=0; case "$st" in L*) locked=1;; esac
    echo "USERROW|$name|$uid|$insudo|$locked"
  fi
done < /etc/passwd`;

  const sessionId = `userslist-${Date.now()}`;
  const mgr = new SSHManager();
  activeSessions.set(sessionId, mgr);
  try {
    await mgr.connect({ host, username: 'Administrator', password, port: port || 22 });
    const result = await mgr.exec(script);
    mgr.dispose();
    activeSessions.delete(sessionId);
    const users = String(result.stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('USERROW|'))
      .map((l) => {
        const p = l.split('|');
        return { name: p[1], uid: Number(p[2]), sudo: p[3] === '1', locked: p[4] === '1' };
      });
    return { ok: true, users };
  } catch (err) {
    mgr.dispose();
    activeSessions.delete(sessionId);
    return { ok: false, error: err.message, users: [] };
  }
});


// User management - write actions (add, delete, passwd, sudo, lock, ssh key)
ipcMain.handle('cx:user-mgmt', async (_evt, opts) => {
  const { host, password, port, action, targetUser, newPassword, sshKey, addSudo, removeHome } = opts || {};
  const sessionId = `usermgmt-${Date.now()}`;
  const b64 = (s) => Buffer.from(String(s == null ? '' : s), 'utf8').toString('base64');
  const escPass = String(password || '').replace(/'/g, "'\\''");

  // Defence in depth - the renderer also blocks these, but never trust the client.
  const PROTECTED = ['root', 'Administrator'];
  if ((action === 'delete' || action === 'lock') && PROTECTED.includes(targetUser)) {
    return { ok: false, error: `Refused: ${action} is blocked for protected user "${targetUser}"` };
  }

  // Per-action body. User-supplied values arrive as base64-decoded shell vars
  // (injection-safe); booleans become safe literal flags here in JS.
  let body, label;
  switch (action) {
    case 'passwd':
      label = `Changing password for ${targetUser}`;
      body = `_sudo sh -c 'printf "%s:%s\\n" "$1" "$2" | chpasswd' _ "$TARGET" "$NEW_PASS"
echo "[CX] Password updated for $TARGET"`;
      break;
    case 'add':
      label = `Creating user ${targetUser}`;
      body = `if id "$TARGET" >/dev/null 2>&1; then echo "[CX] User $TARGET already exists" >&2; exit 1; fi
_sudo useradd -m -s /bin/bash "$TARGET"
_sudo sh -c 'printf "%s:%s\\n" "$1" "$2" | chpasswd' _ "$TARGET" "$NEW_PASS"
${addSudo ? '_sudo usermod -aG sudo "$TARGET"\necho "[CX] $TARGET added to sudo group"' : ''}
echo "[CX] User $TARGET created"`;
      break;
    case 'delete':
      label = `Deleting user ${targetUser}`;
      body = `case "$TARGET" in root|Administrator) echo "[CX] Refusing to delete $TARGET" >&2; exit 1;; esac
_sudo userdel ${removeHome ? '-r ' : ''}"$TARGET"
echo "[CX] User $TARGET deleted${removeHome ? ' (home removed)' : ''}"`;
      break;
    case 'sudo-grant':
      label = `Granting sudo to ${targetUser}`;
      body = `_sudo usermod -aG sudo "$TARGET"
echo "[CX] $TARGET added to sudo group"`;
      break;
    case 'sudo-revoke':
      label = `Revoking sudo from ${targetUser}`;
      body = `_sudo gpasswd -d "$TARGET" sudo
echo "[CX] $TARGET removed from sudo group"`;
      break;
    case 'lock':
      label = `Locking ${targetUser}`;
      body = `case "$TARGET" in root|Administrator) echo "[CX] Refusing to lock $TARGET" >&2; exit 1;; esac
_sudo usermod -L "$TARGET"
echo "[CX] $TARGET locked"`;
      break;
    case 'unlock':
      label = `Unlocking ${targetUser}`;
      body = `_sudo usermod -U "$TARGET"
echo "[CX] $TARGET unlocked"`;
      break;
    case 'sshkey':
      label = `Installing SSH key for ${targetUser}`;
      body = `HOME_DIR="$(_sudo getent passwd "$TARGET" | cut -d: -f6)"
if [ -z "$HOME_DIR" ]; then echo "[CX] User $TARGET not found" >&2; exit 1; fi
_sudo install -d -m 700 -o "$TARGET" "$HOME_DIR/.ssh"
_sudo sh -c 'AK="$2/.ssh/authorized_keys"; touch "$AK"; grep -qxF "$1" "$AK" || printf "%s\\n" "$1" >> "$AK"; chmod 600 "$AK"' _ "$SSH_KEY" "$HOME_DIR"
_sudo chown -R "$TARGET": "$HOME_DIR/.ssh"
echo "[CX] SSH key installed for $TARGET"`;
      break;
    case 'forcechpw':
      label = `Forcing password change for ${targetUser}`;
      body = `_sudo chage -d 0 "$TARGET"
echo "[CX] $TARGET must set a new password at next login"`;
      break;
    default:
      return { ok: false, error: `Unknown user action: ${action}` };
  }

  const script = `#!/bin/bash
set -e
SUDO_PASS='${escPass}'
_sudo() { echo "$SUDO_PASS" | sudo -S -p '' "$@"; }
_sudo -v 2>/dev/null || true
TARGET="$(printf '%s' '${b64(targetUser)}' | base64 -d)"
NEW_PASS="$(printf '%s' '${b64(newPassword)}' | base64 -d)"
SSH_KEY="$(printf '%s' '${b64(sshKey)}' | base64 -d)"
echo "[CX] ${label}..."
${body}`;

  try {
    const result = await sshStream(sessionId, { host, password, port }, script);
    const ok = result.code === 0;
    sendToRenderer('ssh:status', { sessionId, status: ok ? 'complete' : 'failed', message: ok ? `Done: ${action}` : `Failed (exit ${result.code})` });
    return { ok, sessionId, action };
  } catch (err) {
    sendToRenderer('ssh:status', { sessionId, status: 'failed', message: err.message });
    return { ok: false, sessionId, action, error: err.message };
  }
});

// TF1200 - read config.json from CX
ipcMain.handle('cx:read-tf1200-config', async (_evt, opts) => {
  const { host, password, port } = opts || {};
  const escPass = String(password || '').replace(/'/g, "'\\''");
  const cmd = `echo '${escPass}' | sudo -S -p '' cat /home/TF1200/.config/TF1200-UI-Client/config.json 2>&1`;
  const mgr = new SSHManager();
  const sessionId = `readtf1200-${Date.now()}`;
  activeSessions.set(sessionId, mgr);
  try {
    await mgr.connect({ host, username: 'Administrator', password, port: port || 22 });
    const result = await mgr.exec(cmd);
    mgr.dispose();
    activeSessions.delete(sessionId);
    const raw = (result.stdout || '').trim();
    let config;
    try { config = JSON.parse(raw); }
    catch (e) {
      return { ok: false, error: `Could not parse config.json: ${e.message}. Raw: ${raw.slice(0, 120)}` };
    }
    return { ok: true, config };
  } catch (err) {
    mgr.dispose();
    activeSessions.delete(sessionId);
    return { ok: false, error: err.message };
  }
});

// CX info panel - reads system info over SSH
ipcMain.handle('cx:info', async (_evt, opts) => {
  const { host, password, port } = opts || {};
  const escPass = String(password || '').replace(/'/g, "'\\''");
  const mgr = new SSHManager();
  const sessionId = `cxinfo-${Date.now()}`;
  activeSessions.set(sessionId, mgr);
  try {
    await mgr.connect({ host, username: 'Administrator', password, port: port || 22 });

    // One compound command - single round trip, all fields delimited by |||
    const cmd = `
_sudo() { echo '${escPass}' | sudo -S -p '' "$@"; }
echo "HOSTNAME|||$(hostname)"
echo "OS|||$(grep PRETTY_NAME /etc/os-release | cut -d= -f2 | tr -d '"')"
echo "KERNEL|||$(uname -r)"
echo "ARCH|||$(uname -m)"
echo "UPTIME|||$(awk '{d=int($1/86400);h=int(($1%86400)/3600);m=int(($1%3600)/60); if(d>0) printf d"d "h"h"; else if(h>0) printf h"h "m"m"; else printf m"m"}' /proc/uptime)"
echo "TC_VER|||$(dpkg-query -W -f='\${Version}' tc31-xar-um 2>/dev/null || echo unknown)"
echo "FEED|||$(grep -oE 'trixie-[a-z]+' /etc/apt/sources.list.d/bhf.list 2>/dev/null | head -1 || echo unknown)"
df -BM / | awk 'NR==2{t=$2;u=$3;a=$4; gsub("M","",t); gsub("M","",u); gsub("M","",a); gsub("\r","",t); gsub("\r","",u); gsub("\r","",a); pct=int(u/t*100); print "DISK_TOTAL|||"t; print "DISK_USED|||"u; print "DISK_AVAIL|||"a; print "DISK_PCT|||"pct}'
free -m | awk '/^Mem:/{t=$2;u=$3;av=$7; gsub("\r","",t); gsub("\r","",u); gsub("\r","",av); print "MEM_TOTAL|||"t; print "MEM_USED|||"u; print "MEM_AVAIL|||"av}'
ip -o addr show | awk '/inet / && !/127.0.0.1/{split($4,a,"/"); gsub("\r","",a[1]); n=$2; gsub("\r","",n); print "IFACE|||"n"|||"a[1]"/"substr($4,index($4,"/")+1)}'
ip link show | awk '/^[0-9]/{iface=$2; gsub(":","",iface); gsub("\r","",iface)} /state/{for(i=1;i<=NF;i++) if($i=="state"){st=$(i+1); gsub("\r","",st); if(iface~/^(end|eth|eno)/) print "IFACE_STATE|||"iface"|||"(st=="UP"?"up":"down")}}'
for svc in TcSystemServiceUm TcHmiSrv nftables ssh MDPService; do
  st=$(_sudo systemctl is-active $svc 2>/dev/null || echo inactive)
  echo "SVC|||$svc|||$st"
done
`;
    const result = await mgr.exec(cmd);
    mgr.dispose();
    activeSessions.delete(sessionId);

    const info = {};
    const ifaces = {};
    const svcs = [];

    String(result.stdout || '').split(/\r?\n/).forEach(line => {
      const parts = line.trim().replace(/\r/g, '').split('|||');
      if (parts.length < 2) return;
      const [key, v1, v2] = parts;
      switch (key) {
        case 'IFACE':
          if (!ifaces[v1]) ifaces[v1] = {};
          ifaces[v1].ip = v2;
          break;
        case 'IFACE_STATE':
          if (!ifaces[v1]) ifaces[v1] = {};
          ifaces[v1].state = v2;
          break;
        case 'SVC':
          svcs.push({ name: v1, state: v2 });
          break;
        default:
          info[key] = v1;
      }
    });

    return {
      ok: true,
      info,
      ifaces: Object.entries(ifaces).map(([name, d]) => ({ name, ip: d.ip || '-', state: d.state || 'unknown' })),
      svcs
    };
  } catch (err) {
    mgr.dispose();
    activeSessions.delete(sessionId);
    return { ok: false, error: err.message };
  }
});

// APT feed - read MyBeckhoff credentials from CX
ipcMain.handle('cx:read-apt-creds', async (_evt, opts) => {
  const { host, password, port } = opts || {};
  const escPass = String(password || '').replace(/'/g, "'\\''");
  const cmd = `echo '${escPass}' | sudo -S -p '' cat /etc/apt/auth.conf.d/bhf.conf 2>/dev/null`;
  const mgr = new SSHManager();
  try {
    await mgr.connect({ host, username: 'Administrator', password, port: port || 22 });
    const result = await mgr.exec(cmd);
    mgr.dispose();
    const raw = String(result.stdout || '').replace(/\r/g, '');
    // Parse: "machine ...\nlogin <user>\npassword <pass>"
    const loginMatch  = raw.match(/^login\s+(.+)$/m);
    const passMatch   = raw.match(/^password\s+(.+)$/m);
    if (!loginMatch) return { ok: false, error: 'No credentials found on CX' };
    return {
      ok: true,
      username: loginMatch[1].trim(),
      hasPassword: !!passMatch,
      // Never return the actual password - just confirm it exists
    };
  } catch (err) {
    mgr.dispose();
    return { ok: false, error: err.message };
  }
});


// APT feed - switch channel and run apt update
ipcMain.handle('cx:switch-feed', async (_evt, opts) => {
  const { host, password, port, feed } = opts || {};
  const sessionId = `switchfeed-${Date.now()}`;
  const escPass = String(password || '').replace(/'/g, "'\\''");
  const channel = feed === 'trixie-unstable' ? 'trixie-unstable' : 'trixie-stable';

  const script = `#!/bin/bash
set -e
export TERM=dumb
export DEBIAN_FRONTEND=noninteractive
APT_OPTS='-o Dpkg::Progress-Fancy=0 -o Dpkg::Use-Pty=0 -o APT::Color=0 -o Quiet::NoUpdate=true'
SUDO_PASS='${escPass}'
_sudo() { echo "$SUDO_PASS" | sudo -S -p '' "$@"; }
_sudo -v
trap 'rm -f "$0"' EXIT
echo "[CX] Switching APT feed to: ${channel}"
_sudo bash -c 'printf "deb [signed-by=/usr/share/keyrings/bhf.asc] https://deb.beckhoff.com/debian ${channel} main\\n" > /etc/apt/sources.list.d/bhf.list'
echo "[CX] Feed set to ${channel}. Running apt update..."
_sudo apt $APT_OPTS update -y
echo "[CX] Done. Feed is now ${channel}."
`;

  try {
    const mgr = new SSHManager();
    activeSessions.set(sessionId, mgr);
    sendToRenderer('ssh:output', { sessionId, data: `\x1b[0;36m[LOCAL]\x1b[0m Switching feed to ${channel}...\r\n` });
    await mgr.connect({ host, username: 'Administrator', password, port: port || 22 });
    await withTempScript('cx-switchfeed', script, (p) => mgr.putFile(p, '/tmp/cx_switchfeed.sh'));
    const result = await mgr.execStream('chmod +x /tmp/cx_switchfeed.sh && /tmp/cx_switchfeed.sh', {
      onStdout: (c) => sendToRenderer('ssh:output', { sessionId, data: c.toString() }),
      onStderr: (c) => sendToRenderer('ssh:output', { sessionId, data: c.toString() })
    });
    mgr.dispose();
    activeSessions.delete(sessionId);
    const ok = result.code === 0;
    sendToRenderer('ssh:status', { sessionId, status: ok ? 'complete' : 'failed', message: ok ? `Feed switched to ${channel}` : `Exit ${result.code}` });
    return { ok, sessionId, channel };
  } catch (err) {
    sendToRenderer('ssh:status', { sessionId, status: 'failed', message: err.message });
    return { ok: false, error: err.message };
  }
});


// APT feed - run apt update only
ipcMain.handle('cx:update-feed', async (_evt, opts) => {
  const { host, password, port } = opts || {};
  const sessionId = `updatefeed-${Date.now()}`;
  const escPass = String(password || '').replace(/'/g, "'\\''");

  const script = `#!/bin/bash
set -e
export TERM=dumb
export DEBIAN_FRONTEND=noninteractive
APT_OPTS='-o Dpkg::Progress-Fancy=0 -o Dpkg::Use-Pty=0 -o APT::Color=0 -o Quiet::NoUpdate=true'
SUDO_PASS='${escPass}'
_sudo() { echo "$SUDO_PASS" | sudo -S -p '' "$@"; }
_sudo -v
FEED=$(grep -oE 'trixie-[a-z]+' /etc/apt/sources.list.d/bhf.list 2>/dev/null | head -1 || echo unknown)
trap 'rm -f "$0"' EXIT
echo "[CX] Running apt update on feed: $FEED"
_sudo apt $APT_OPTS update -y
echo "[CX] apt update complete."
`;

  try {
    const mgr = new SSHManager();
    activeSessions.set(sessionId, mgr);
    sendToRenderer('ssh:output', { sessionId, data: `\x1b[0;36m[LOCAL]\x1b[0m Running apt update...\r\n` });
    await mgr.connect({ host, username: 'Administrator', password, port: port || 22 });
    await withTempScript('cx-updatefeed', script, (p) => mgr.putFile(p, '/tmp/cx_updatefeed.sh'));
    const result = await mgr.execStream('chmod +x /tmp/cx_updatefeed.sh && /tmp/cx_updatefeed.sh', {
      onStdout: (c) => sendToRenderer('ssh:output', { sessionId, data: c.toString() }),
      onStderr: (c) => sendToRenderer('ssh:output', { sessionId, data: c.toString() })
    });
    mgr.dispose();
    activeSessions.delete(sessionId);
    const ok = result.code === 0;
    sendToRenderer('ssh:status', { sessionId, status: ok ? 'complete' : 'failed', message: ok ? 'apt update complete' : `Exit ${result.code}` });
    return { ok, sessionId };
  } catch (err) {
    sendToRenderer('ssh:status', { sessionId, status: 'failed', message: err.message });
    return { ok: false, error: err.message };
  }
});

// Connection profiles - load from disk
ipcMain.handle('profiles:load', async () => {
  const profilesPath = path.join(app.getPath('userData'), 'cx-profiles.json');
  try {
    const raw = await fs.promises.readFile(profilesPath, 'utf8');
    return { ok: true, profiles: JSON.parse(raw) };
  } catch (e) {
    // File doesn't exist yet - return empty array
    return { ok: true, profiles: [] };
  }
});

// Connection profiles - save to disk
ipcMain.handle('profiles:save', async (_evt, { profiles }) => {
  const profilesPath = path.join(app.getPath('userData'), 'cx-profiles.json');
  try {
    await fs.promises.writeFile(profilesPath, JSON.stringify(profiles, null, 2), 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});


// Service management - list, status, start, stop, restart, TF2000 reinit
ipcMain.handle('cx:service-mgmt', async (_evt, opts) => {
  const { host, password, port, action, service, tf2000Pass } = opts || {};
  const sessionId = `svcmgmt-${Date.now()}`;

  // Service names come from the renderer (which got them from the CX) and are
  // interpolated into a shell script - never let a hostile name through
  const needsService = ['status', 'start', 'stop', 'restart'].includes(action);
  if (needsService && !UNIT_RE.test(String(service || ''))) {
    return { ok: false, error: `Invalid or missing service name: ${service}` };
  }
  const escPass = String(password || '').replace(/'/g, "'\\''");

  // Pinned services - always shown first with friendly labels
  const PINNED = {
    TcSystemServiceUm: { label: 'TcSystemServiceUm', desc: 'TwinCAT 3 runtime',      canStop: true  },
    TcHmiSrv:          { label: 'TcHmiSrv',          desc: 'TF2000 HMI Server',       canStop: true  },
    nftables:          { label: 'nftables',           desc: 'Firewall',                canStop: true  },
    ssh:               { label: 'ssh',                desc: 'SSH daemon',              canStop: false },
    MDPService:        { label: 'MDPService',         desc: 'MDP service',             canStop: true  },
  };

  // Services that never get a stop button regardless of how they were discovered
  const NO_STOP = new Set(['ssh', 'systemd-networkd', 'dbus', 'dbus-broker', 'NetworkManager']);

  // Patterns that match relevant discovered services
  const RELEVANT = /^(Tc|tf|te|mdp|ads|bhf|beckhoff)/i;

  // Patterns to exclude from discovery entirely
  const EXCLUDE = /^(systemd-|getty|serial-|console-|keyboard-|plymouth|udev|kmod|apparmor|blk-|dev-|proc-|sys-|run-|-.+\.mount|-.+\.scope|-.+\.slice|-.+\.socket|-.+\.path|-.+\.timer|-.+\.device)/;

  // List all relevant services from the CX
  if (action === 'list') {
    const mgr = new SSHManager();
    try {
      await mgr.connect({ host, username: 'Administrator', password, port: port || 22 });
      // List all service units, get name and active state
      const result = await mgr.exec(
        `systemctl list-units --type=service --all --no-pager --no-legend 2>/dev/null | awk '{print $1, $3, $4}'`
      );
      const discovered = [];
      String(result.stdout || '').replace(/\r/g, '').split('\n').forEach(line => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) return;
        let name = parts[0].replace(/\.service$/, '');
        const state = parts[2] || parts[1] || 'unknown';
        if (PINNED[name]) return; // handled separately
        if (EXCLUDE.test(name)) return;
        if (!RELEVANT.test(name)) return;
        discovered.push({ id: name, label: name, desc: '', state, canStop: !NO_STOP.has(name), pinned: false });
      });

      // States for pinned services - same connection, no reconnect
      const pinnedWithStates = await Promise.all(Object.entries(PINNED).map(async ([id, meta]) => {
        const r = await mgr.exec(`systemctl is-active ${id} 2>/dev/null; true`).catch(() => ({ stdout: '' }));
        const state = String((r && r.stdout) || '').replace(/\r/g, '').split('\n')[0].trim() || 'unknown';
        return { id, ...meta, state, pinned: true, canStop: meta.canStop && !NO_STOP.has(id) };
      }));
      mgr.dispose();

      return { ok: true, services: [...pinnedWithStates, ...discovered] };
    } catch (err) {
      mgr.dispose();
      return { ok: false, error: err.message, services: [] };
    }
  }

  // Status of a single service
  if (action === 'status') {
    const mgr = new SSHManager();
    try {
      await mgr.connect({ host, username: 'Administrator', password, port: port || 22 });
      const result = await mgr.exec(`systemctl is-active "${service}" 2>/dev/null || echo inactive`);
      mgr.dispose();
      const state = String(result.stdout || '').replace(/\r?\n/g, '').trim();
      return { ok: true, service, state };
    } catch (err) {
      mgr.dispose();
      return { ok: false, error: err.message };
    }
  }

  // TF2000 reinitialise
  if (action === 'reinit') {
    const escTf2000Pass = String(tf2000Pass || '1').replace(/'/g, "'\\''");
    const script = `#!/bin/bash
set -e
export TERM=dumb
SUDO_PASS='${escPass}'
_sudo() { echo "$SUDO_PASS" | sudo -S -p '' "$@"; }
_sudo -v
trap 'rm -f "$0"' EXIT
echo "[CX] Stopping TcHmiSrv..."
_sudo systemctl stop TcHmiSrv || true
echo "[CX] Removing HMI Server init state..."
_sudo rm -rf /var/lib/tchmisrv/* 2>/dev/null || true
_sudo rm -f /etc/TwinCAT/Functions/TF2000-HMI-Server/TcHmiSrv.cfg 2>/dev/null || true
echo "[CX] Reinitialising TF2000 HMI Server..."
_sudo TcHmiSrv --initialize --password='${escTf2000Pass}'
echo "[CX] Enabling and starting TcHmiSrv..."
_sudo systemctl enable TcHmiSrv
_sudo systemctl start TcHmiSrv
sleep 2
STATE=$(_sudo systemctl is-active TcHmiSrv 2>/dev/null || echo unknown)
echo "[CX] TcHmiSrv is now: $STATE"
`;
    try {
      const mgr = new SSHManager();
      activeSessions.set(sessionId, mgr);
      sendToRenderer('ssh:output', { sessionId, data: `\x1b[0;36m[LOCAL]\x1b[0m Reinitialising TF2000 HMI Server...\r\n` });
      await mgr.connect({ host, username: 'Administrator', password, port: port || 22 });
      await withTempScript('cx-reinit', script, (p) => mgr.putFile(p, '/tmp/cx_reinit.sh'));
      const result = await mgr.execStream('chmod +x /tmp/cx_reinit.sh && /tmp/cx_reinit.sh', {
        onStdout: (c) => sendToRenderer('ssh:output', { sessionId, data: c.toString() }),
        onStderr: (c) => sendToRenderer('ssh:output', { sessionId, data: c.toString() })
      });
      mgr.dispose();
      activeSessions.delete(sessionId);
      const ok = result.code === 0;
      sendToRenderer('ssh:status', { sessionId, status: ok ? 'complete' : 'failed', message: ok ? 'TF2000 reinitialised' : `Exit ${result.code}` });
      return { ok, sessionId };
    } catch (err) {
      sendToRenderer('ssh:status', { sessionId, status: 'failed', message: err.message });
      return { ok: false, error: err.message };
    }
  }

  // start / stop / restart
  const VALID_ACTIONS = ['start', 'stop', 'restart'];
  if (!VALID_ACTIONS.includes(action)) return { ok: false, error: `Unknown action: ${action}` };
  if (action === 'stop' && NO_STOP.has(service)) {
    return { ok: false, error: `Stopping ${service} is blocked - it would disconnect you or crash the system.` };
  }

  const script = `#!/bin/bash
set -e
SUDO_PASS='${escPass}'
_sudo() { echo "$SUDO_PASS" | sudo -S -p '' "$@"; }
_sudo -v
trap 'rm -f "$0"' EXIT
echo "[CX] systemctl ${action} ${service}"
_sudo systemctl ${action} "${service}"
sleep 1
STATE=$(_sudo systemctl is-active "${service}" 2>/dev/null || echo unknown)
echo "[CX] ${service} is now: $STATE"
`;

  try {
    const mgr = new SSHManager();
    activeSessions.set(sessionId, mgr);
    sendToRenderer('ssh:output', { sessionId, data: `\x1b[0;36m[LOCAL]\x1b[0m ${action} ${service}...\r\n` });
    await mgr.connect({ host, username: 'Administrator', password, port: port || 22 });
    await withTempScript('cx-svc', script, (p) => mgr.putFile(p, '/tmp/cx_svc.sh'));
    const result = await mgr.execStream('chmod +x /tmp/cx_svc.sh && /tmp/cx_svc.sh', {
      onStdout: (c) => sendToRenderer('ssh:output', { sessionId, data: c.toString() }),
      onStderr: (c) => sendToRenderer('ssh:output', { sessionId, data: c.toString() })
    });
    mgr.dispose();
    activeSessions.delete(sessionId);
    const ok = result.code === 0;
    sendToRenderer('ssh:status', { sessionId, status: ok ? 'complete' : 'failed', message: ok ? `${service} ${action}ed` : `Exit ${result.code}` });
    return { ok, sessionId };
  } catch (err) {
    sendToRenderer('ssh:status', { sessionId, status: 'failed', message: err.message });
    return { ok: false, error: err.message };
  }
});

// find CXs on the network or wired direct to this laptop
ipcMain.handle('cx:discover', async () => {
  try {
    const result = await discovery.discoverAll();
    return { ok: true, devices: result.devices, capped: result.capped };
  } catch (err) {
    return { ok: false, error: err.message || String(err), devices: [] };
  }
});

// resolve a direct-link device's IPv4 without touching IPv6 SSH.
// ping the 169.254 broadcast to prime the OS ARP cache, then read it by MAC.
// if the CX blocks ICMP, falls back to a parallel SSH sweep of 169.254.0.0/16.
ipcMain.handle('cx:resolve-direct', async (_evt, opts) => {
  const { mac, laptopIp } = opts || {};
  if (!mac || !laptopIp) return { ok: false, error: 'Missing MAC or laptop IP' };
  try {
    const ip = await discovery.resolveDirectLinkIp(mac, laptopIp);
    if (!ip) return { ok: false, error: 'Could not find device. Check the cable is connected and try IDENTIFY again.' };
    return { ok: true, ip };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});