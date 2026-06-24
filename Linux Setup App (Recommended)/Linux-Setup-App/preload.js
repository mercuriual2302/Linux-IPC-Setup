//Stop snooping around... 


// preload.js runs in isolated context, bridges renderer ↔ main
const { contextBridge, ipcRenderer } = require('electron');

const VALID_EVENTS = ['ssh:output', 'ssh:status'];

contextBridge.exposeInMainWorld('api', {
  // one-shot invokes — existing
  testConnection: (opts) => ipcRenderer.invoke('ssh:test', opts),
  fetchPackages:  (opts) => ipcRenderer.invoke('ssh:fetch-packages', opts),
  runSetup:       (opts) => ipcRenderer.invoke('ssh:run-setup', opts),
  runTF1200:      (opts) => ipcRenderer.invoke('ssh:run-tf1200', opts),
  cancelSession:  (sessionId) => ipcRenderer.invoke('ssh:cancel', { sessionId }),
  buildSetupScript:  (opts) => ipcRenderer.invoke('script:build-setup', opts),
  buildTF1200Script: (opts) => ipcRenderer.invoke('script:build-tf1200', opts),
  saveScript:     (content, defaultName) => ipcRenderer.invoke('script:save', { content, defaultName }),

  // CX Management — new
  validateCreds:  (opts) => ipcRenderer.invoke('cx:validate-creds', opts),
  applyNetwork:   (opts) => ipcRenderer.invoke('cx:network', opts),
  applyFirewall:  (opts) => ipcRenderer.invoke('cx:firewall', opts),
  changePassword: (opts) => ipcRenderer.invoke('cx:passwd', opts),
  usersList:      (opts) => ipcRenderer.invoke('cx:users-list', opts),
  userMgmt:       (opts) => ipcRenderer.invoke('cx:user-mgmt', opts),
  readTF1200Config: (opts) => ipcRenderer.invoke('cx:read-tf1200-config', opts),
  cxInfo:           (opts) => ipcRenderer.invoke('cx:info', opts),
  readAptCreds:     (opts) => ipcRenderer.invoke('cx:read-apt-creds', opts),
  switchFeed:       (opts) => ipcRenderer.invoke('cx:switch-feed', opts),
  updateFeed:       (opts) => ipcRenderer.invoke('cx:update-feed', opts),
  tcRuntime:      (opts) => ipcRenderer.invoke('cx:tc-runtime', opts),
  power:          (opts) => ipcRenderer.invoke('cx:power', opts),
  fetchUpdates:   (opts) => ipcRenderer.invoke('cx:fetch-updates', opts),
  runUpgrade:     (opts) => ipcRenderer.invoke('cx:upgrade', opts),
  runVerify:      (opts) => ipcRenderer.invoke('cx:verify', opts),

  // streaming events
  on: (channel, cb) => {
    if (!VALID_EVENTS.includes(channel)) {
      console.warn('[preload] refused unknown channel:', channel);
      return () => {};
    }
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  platform: process.platform,
  versions: { ...process.versions }
});