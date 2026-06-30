# Linux IPC Setup Console

A desktop app for provisioning Beckhoff Linux IPCs without touching a terminal. Point it at a CX, pick your packages, and let it handle the rest over SSH.

Built with Electron. Tested on CX9240 running Debian trixie (arm64).

---

## What it does

Connects to a target CX over SSH and runs the full provisioning sequence automatically: writes MyBeckhoff APT credentials, sets the feed channel, installs the TwinCAT 3 runtime and any optional packages you select, initialises TF2000 HMI Server if needed, configures TF1200 UI Client, and reboots. Output streams live so you can watch it happen.

Beyond initial setup there's a full set of post-provisioning tools: network configuration, firewall management, user and password management, SSH key installation, package updates, APT feed switching, a live system info dashboard, a device discovery scanner for finding a CX with no known IP, a live interactive shell, and a dual-pane SFTP file browser.

If the CX itself has no internet access, the app can offer to route package downloads through your own laptop's connection for that run.

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

## Layout

The app is one window. A connection bar runs across the top, enter the CX IP and Administrator password once and every view uses it. A Scan button next to it finds a CX on your network or wired directly to your laptop, even if you don't know its IP yet. A sidebar on the left holds every view, grouped by what they're for:

- **Overview** - Dashboard, a live read-out of the connected CX
- **Provision** - Setup, the full first-time provisioning run
- **Manage** - Services, Network, Firewall, Users, Packages
- **Configure** - TF1200 UI Client
- **Tools** - Shell, Files

A collapsible terminal drawer sits at the bottom of the window and shows live output from whatever action you run. This is separate from the Shell tool, the drawer is a passive log of what the app itself is doing, Shell is a real interactive terminal session you type into yourself.

### Dashboard
Live system info: hostname, uptime, kernel, TwinCAT version, APT feed, storage, memory, network interfaces, and service status. Loads automatically once you're connected.

### Setup
The main provisioning flow. Enter your MyBeckhoff credentials, choose a feed channel (`trixie-stable` recommended, `trixie-unstable` only if Beckhoff support tells you to), pick your packages, optionally pin specific versions, and run.

Always installed:
- `tc31-xar-um` (TwinCAT 3 XAR runtime)
- `console-setup`

Optional packages are fetched live from the connected feed, so the list always reflects what's actually available.

If the HMI server has already been initialised from a previous run, setup skips re-initialisation and just ensures the service is running, so you can run setup more than once without wiping your HMI project. The same goes for MyBeckhoff credentials, if they're already saved on the CX from a past run, you don't need to retype the password to run setup again.

You can also generate a standalone `.sh` script instead of running live, which works from any bash terminal with `sshpass` installed.

### Services, Network, Firewall, Users, Packages
Day to day management once a CX is already set up. Restart services, change network settings, manage the firewall, add or remove users, switch the APT feed, and check for package updates, all without running a full setup again.

### TF1200 UI Client
Configures the kiosk browser that shows your HMI on a screen plugged into the CX. Reads the existing config first so nothing gets overwritten by accident, and takes a timestamped backup before applying changes.

### Shell
A real interactive terminal session over SSH. Things like `vim`, `top`, `journalctl -f`, and sudo password prompts all work properly here, this isn't a one-shot command box, it's a full terminal. The session stays alive while you switch to other views and back.

### Files
A dual-pane SFTP browser, your laptop on one side and the CX on the other. Upload, download, preview text files inline, create folders, and delete things, with a confirmation before anything gets overwritten. SFTP has no concept of `sudo`, so it can only reach files the connected account already has permission to read, anything restricted to another user needs Shell instead.

### Device discovery
Press Scan in the connection bar to find a CX without typing its IP. Works two ways: a CX on the same network as your laptop is found by its MAC address, a CX wired directly to your laptop with no IP assigned yet is found over its link-local address. Devices are tagged Linux or Windows so you don't pick the wrong one, and picking a device asks for its password right there rather than reusing whatever's already in the connection bar.

### Internet access for the CX
If Setup or credential validation detects the CX can't reach the Beckhoff package feed, the app offers to route that traffic through your own laptop's internet connection instead. You're always asked first, nothing happens automatically. Once you've answered for a given CX, the same answer is reused for the rest of that session, you won't be asked twice for the same unit.

---

## Connection profiles

The Profiles button in the connection bar saves and loads named CX configurations (name, IP, Administrator password, optionally MyBeckhoff credentials). Profiles are stored locally in the app's user data folder and are never committed to the repo. Click a saved profile to load every field at once.

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
      ssh-manager.js    -- node-ssh wrapper (connect, exec, shell, SFTP transfers)
      script-builder.js -- generates the bash scripts that run on the CX
      sftp-manager.js   -- SFTP listing, mkdir, delete, realpath
      discovery.js      -- network and direct-link device discovery
      socks-proxy.js    -- hand-rolled SOCKS5 server for the laptop-as-proxy option
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
- SFTP needs the `sftp-server` subsystem enabled on the CX's sshd. It's present on the standard CX9240 image, but if you're working with a more stripped-down image and Files won't connect, check `/etc/ssh/sshd_config` for a `Subsystem sftp ...` line.
- Connection profiles are stored in `%APPDATA%\linux-ipc0-setup-console\cx-profiles.json` on Windows. They are not synced to any repo.