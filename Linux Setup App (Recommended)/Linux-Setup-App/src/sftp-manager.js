// src/sftp-manager.js - thin promisified wrapper around the raw SFTP subsystem
// (ssh2's SFTPWrapper, obtained via SSHManager.requestSFTP()). Used only by the
// Files (SFTP) view. Actual file transfers go through node-ssh's getFile/putFile
// in ssh-manager.js - this module is just listing, mkdir, delete, realpath.

function listDir(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (err, list) => {
      if (err) return reject(err);
      const entries = list.map((item) => {
        const attrs = item.attrs || {};
        const mode = attrs.mode || 0;
        const isDir = typeof attrs.isDirectory === 'function' ? attrs.isDirectory() : ((mode & 0o170000) === 0o040000);
        const isLink = typeof attrs.isSymbolicLink === 'function' ? attrs.isSymbolicLink() : ((mode & 0o170000) === 0o120000);
        return {
          name: item.filename,
          type: isDir ? 'dir' : isLink ? 'link' : 'file',
          size: attrs.size || 0,
          mtime: (attrs.mtime || 0) * 1000 // SFTP gives unix seconds, JS Date wants ms
        };
      });
      resolve(entries);
    });
  });
}

function mkdir(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.mkdir(remotePath, (err) => err ? reject(err) : resolve());
  });
}

function unlink(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.unlink(remotePath, (err) => err ? reject(err) : resolve());
  });
}

function rmdir(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.rmdir(remotePath, (err) => err ? reject(err) : resolve());
  });
}

function stat(sftp, remotePath) {
  return new Promise((resolve) => {
    sftp.stat(remotePath, (err, stats) => resolve(err ? null : stats));
  });
}

// resolves '.' to the SSH session's actual starting directory (home dir)
// without us having to guess /home/Administrator vs /root vs anything else.
function realpath(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.realpath(remotePath, (err, abs) => err ? reject(err) : resolve(abs));
  });
}

module.exports = { listDir, mkdir, unlink, rmdir, stat, realpath };