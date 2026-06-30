// src/ssh-manager.js — thin wrapper around node-ssh
const { NodeSSH } = require("node-ssh");

class SSHManager {
  constructor() {
    this.ssh = new NodeSSH();
    this._disposed = false;
    this._currentStream = null;
  }

  async connect({
    host,
    username,
    password,
    port = 22,
    privateKey,
    passphrase,
    readyTimeout = 15000,
  }) {
    const config = {
      host,
      username,
      port,
      readyTimeout,
      // Beckhoff CX / TwinCAT BSD(might make an app for that) often uses older ciphers — be permissive.
      algorithms: {
        kex: [
          "curve25519-sha256",
          "curve25519-sha256@libssh.org",
          "ecdh-sha2-nistp256",
          "ecdh-sha2-nistp384",
          "ecdh-sha2-nistp521",
          "diffie-hellman-group14-sha256",
          "diffie-hellman-group16-sha512",
          "diffie-hellman-group18-sha512",
          "diffie-hellman-group-exchange-sha256",
          "diffie-hellman-group14-sha1",
        ],
        serverHostKey: [
          "ssh-ed25519",
          "ecdsa-sha2-nistp256",
          "ecdsa-sha2-nistp384",
          "ecdsa-sha2-nistp521",
          "rsa-sha2-512",
          "rsa-sha2-256",
          "ssh-rsa",
        ],
        cipher: [
          "aes128-gcm",
          "aes128-gcm@openssh.com",
          "aes256-gcm",
          "aes256-gcm@openssh.com",
          "aes128-ctr",
          "aes192-ctr",
          "aes256-ctr",
        ],
        hmac: [
          "hmac-sha2-256-etm@openssh.com",
          "hmac-sha2-512-etm@openssh.com",
          "hmac-sha1-etm@openssh.com",
          "hmac-sha2-256",
          "hmac-sha2-512",
          "hmac-sha1",
        ],
      },
    };

    if (privateKey) {
      config.privateKey = privateKey;
      if (passphrase) config.passphrase = passphrase;
    } else {
      config.password = password;
      // Needed for some CX images that force keyboard-interactive
      config.tryKeyboard = true;
      config.onKeyboardInteractive = (
        _name,
        _instructions,
        _lang,
        prompts,
        finish,
      ) => {
        if (prompts.length > 0) finish([password]);
      };
    }

    await this.ssh.connect(config);
  }

  /** Run a single command, buffer full output. Good for short queries. */
  async exec(cmd) {
    if (this._disposed) throw new Error("SSH manager disposed");
    const result = await this.ssh.execCommand(cmd, {
      execOptions: { pty: true },
    });
    return result; // { stdout, stderr, code, signal }
  }

  /**
   * Run a command and stream stdout/stderr chunks to callbacks as they arrive.
   * Returns { stdout, stderr, code } once the command completes.
   */
  async execStream(cmd, { onStdout, onStderr } = {}) {
    if (this._disposed) throw new Error("SSH manager disposed");

    // node-ssh v13+ supports onStdout / onStderr chunk callbacks in execCommand.
    // Using pty: true matches the original scripts' `ssh -t -t` behavior so sudo
    // with TTY-only prompts behaves correctly and colored output is preserved.
    const result = await this.ssh.execCommand(cmd, {
      execOptions: { pty: true },
      onStdout: (chunk) => {
        if (!this._disposed && onStdout) onStdout(chunk);
      },
      onStderr: (chunk) => {
        if (!this._disposed && onStderr) onStderr(chunk);
      },
    });
    return result;
  }

  /** Upload a local file to the remote CX via SFTP. */
  async putFile(localPath, remotePath) {
    if (this._disposed) throw new Error("SSH manager disposed");
    await this.ssh.putFile(localPath, remotePath);
  }

  /**
   * Open an interactive PTY shell channel on the existing connection.
   * Returns the raw ssh2 stream - duplex, write() sends keystrokes,
   * 'data' events are the terminal's raw output bytes. Used by the
   * Shell view; separate from exec()/execStream() which are one-shot.
   */
  shell({ cols = 80, rows = 24, term = "xterm-256color" } = {}) {
    if (this._disposed) throw new Error("SSH manager disposed");
    if (!this.ssh.connection) throw new Error("Not connected");
    return new Promise((resolve, reject) => {
      this.ssh.connection.shell({ term, cols, rows }, (err, stream) => {
        if (err) return reject(err);
        resolve(stream);
      });
    });
  }

  /** Tear down the connection — safe to call multiple times. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    try {
      if (this.ssh && this.ssh.isConnected && this.ssh.isConnected()) {
        this.ssh.dispose();
      } else if (this.ssh) {
        this.ssh.dispose();
      }
    } catch (_) {
      /* ignore */
    }
  }

  isConnected() {
    return (
      !this._disposed &&
      this.ssh &&
      this.ssh.isConnected &&
      this.ssh.isConnected()
    );
  }
}

module.exports = SSHManager;