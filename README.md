# Linux IPC Setup Console

A desktop app for provisioning Beckhoff Linux IPCs without touching a terminal. Point it at a CX, pick your packages, and let it handle the rest over SSH.

Built with Electron. Tested on CX9240 running Debian trixie (arm64).

---

## What it does

Connects to a target CX over SSH and runs the full provisioning sequence automatically: writes MyBeckhoff APT credentials, sets the feed channel, installs the TwinCAT 3 runtime and any optional packages you select, initialises TF2000 HMI Server if needed, configures TF1200 UI Client, and reboots. Output streams live into the built-in terminal so you can watch it happen.

There is also a management tab for post-provisioning tasks: network configuration, firewall management, user and password management, SSH key installation, package updates, APT feed switching, and a live system info dashboard.

---

## Requirements

**To run from source:**
- Node.js 18 or newer
- npm

**To run the pre-built exe:**
- Nothing. Just double-click it.

**Target hardware:**
- Beckhoff CX9240 (or compatible) running Debian trixie RT Linux (arm64)
- SSH enabled, port 22, `Administrator` account active
- MyBeckhoff account with a TwinCAT software entitlement

---

## Getting started

```bash
git clone https://github.com/mercuriual2302/Linux-IPC-Setup.git
cd "Linux-IPC-Setup/Linux Setup App (Recommended)/Linux-Setup-App"
npm install
npm start
```

Build your own exe:

```bash
# NSIS installer + portable exe (Windows x64)
npm run dist

# Installer only
npm run build:win

# Portable exe only
npm run build:portable
```

Output goes to `dist/`. The app icon is read from `build/icon.ico`.

---

## Tabs

### Full Setup
The main provisioning flow. Enter the CX IP, Administrator password, and MyBeckhoff credentials. Choose a feed channel (`trixie-stable` recommended, `trixie-unstable` only if Beckhoff support tells you to). Pick your packages, optionally pin specific versions, and click Run.

Always installed:
- `tc31-xar-um` (TwinCAT 3 XAR runtime)
- `console-setup`

Optional packages are fetched live from the connected feed via `apt-cache search`, so the list always reflects what is actually available.

Special handling for TF2000: if the HMI server has already been initialised from a previous run, setup skips re-initialisation and just ensures the service is running. You can run the full setup multiple times without wiping your HMI project.

You can also generate a standalone `.sh` script instead of running live, which works from any bash terminal with `sshpass` installed.

After a successful test connection, the app checks whether MyBeckhoff credentials already exist on the CX (`/etc/apt/auth.conf.d/bhf.conf`) and pre-fills the username field if they do. The password is never read back.

### TF1200 Config
Configures TF1200 UI Client on an already-provisioned CX. Set the HMI URL, toggle kiosk mode, manage Chromium command-line switches, and apply the config via SSH. A timestamped backup of the existing config is created before any changes are made.

The **Read from CX** button reads the current `config.json` from the CX and populates all the editor fields before you make any changes, so nothing gets accidentally overwritten.

### CX Management
Post-provisioning ops without re-running the full setup.

- **CX Information** - live dashboard showing hostname, uptime, kernel, TwinCAT version, APT feed channel, storage, memory, network interfaces, and service status. Reads in a single SSH session.
- **Network** - configure `end0` or `end1` as DHCP or static, applied immediately via `systemd-networkd`
- **Firewall** - manage `nftables` rules, with pre-configured toggles for ADS, OPC-UA, HMI, and SSH ports
- **APT Feed Manager** - switch between `trixie-stable` and `trixie-unstable` without running a full setup, or just run `apt update` against the current feed
- **User Management** - list local accounts, change passwords, add and remove users, grant or revoke sudo, lock and unlock accounts, install SSH public keys, force password change at next login
- **Package Updates** - check for upgrades against the Beckhoff feed and selectively upgrade packages without running a full setup
- **Power** - shutdown, restart, or restart just the TwinCAT runtime from the header menu, available from any tab

### Terminal
Live SSH output for every operation. ANSI colour codes are rendered so the output looks the same as a real terminal. A progress bar tracks long-running operations. Generated scripts can be copied or saved from here.

---

## Connection profiles

The **Profiles** button in the header saves and loads named CX configurations (name, IP, Administrator password, optionally MyBeckhoff credentials). Profiles are stored locally in the app's user data folder and are never committed to the repo. Click a saved profile to load all fields at once across every tab.

---

## Credential sync

All tabs share the same connection credentials. Entering an IP or password in any tab updates all the others automatically. The HMI URL in the TF1200 tab auto-fills from the IP unless you have manually set a different one.

---

## Credentials

MyBeckhoff credentials are used only to write `/etc/apt/auth.conf.d/bhf.conf` on the CX. They are not stored locally anywhere. The Administrator password is held in memory for the duration of the session and used only for SSH authentication and `sudo` operations on the CX. Connection profiles are stored in the OS user data folder outside the repo.

---

## Repo structure

```
Linux Setup App (Recommended)/
  Linux-Setup-App/
    main.js           -- Electron main process, all IPC handlers
    preload.js        -- contextBridge, exposes window.api to renderer
    src/
      ssh-manager.js    -- node-ssh wrapper
      script-builder.js -- generates the bash scripts that run on the CX
    renderer/
      index.html        -- app shell and all UI
      renderer.js       -- event handlers and SSH wiring
      styles.css        -- all styles, light and dark theme
sample-scripts/         -- standalone bash scripts for the no-Electron workflow
Linux Setup Guide.docx  -- end user guide
```

---

## Notes

- The app enforces a single instance. Launching a second copy will focus the existing window.
- The default Administrator password on a fresh CX image is `1`.
- If you change the CX IP via the Network Configurator while connected through that interface, the SSH session will drop. That is expected.
- Shutting down the CX from the Power menu is a full ACPI power-off. It will not come back on its own. Use Restart if you want it to come back automatically.
- The `trixie-unstable` feed should only be used if Beckhoff support specifically instructs you to. Stable is the right choice for production deployments.
- Connection profiles are stored in `%APPDATA%\linux-ipc0-setup-console\cx-profiles.json` on Windows. They are not synced to any repo.