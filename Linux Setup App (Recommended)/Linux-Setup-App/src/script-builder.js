// If you're redaidn this send help... JavaScript will be the end of me... 
// src/script-builder.js — builds shell scripts for the CX
//
// Two families of outputs:
//   • buildFullSetup / buildFullTF1200    → drop-in bash scripts equivalent to
//     the originals from twincat_setup_gui_v4.html. Used by the Copy / Download
//     buttons so the "no Electron" workflow still works.
//   • buildInnerSetup / buildInnerTF1200  → just the part that RUNS ON THE CX
//     (no sshpass wrapper, no scp). Used by main.js for direct execution over
//     node-ssh with live streaming. Positional args ($1, $2, …) are passed by
//     the SSH layer.
//
// Note: $APT_OPTS is a shell variable defined inside the inner script itself;
// these install lines expand to `sudo apt $APT_OPTS install -y ...` on the CX.
function installLine(name, pkgVersions) {
  const v = pkgVersions && pkgVersions[name];
  if (v && v.mode === 'pinned' && v.version) {
    return `sudo apt $APT_OPTS install -y ${name}=${v.version}`;
  }
  return `sudo apt $APT_OPTS install -y ${name}`;
}

function feedSedLine(feed) {
  return feed === 'trixie-stable'
    ? '# Feed: trixie-stable (default, no change needed)'
    : "sudo sed -i 's/trixie-stable/trixie-unstable/g' /etc/apt/sources.list.d/bhf.list";
}

//INNER: full setup (runs on CX as /tmp/twincat_setup.sh $1 $2 $3)
function buildInnerSetupScript({ feed = 'trixie-stable', packages = [], pkgVersions = {}, tf2000Pass = '1' } = {}) {
  const pkgs = Array.isArray(packages) ? packages : [];
  // Swap all "sudo " → "_sudo " in package install / feed / helper lines so
  // every elevated command goes through the password-feeding wrapper.
  const sudofy = (s) => s.replace(/(^|\s|\|)sudo /g, '$1_sudo ');

  const pkgLines = pkgs.map((p) => {
    const install = sudofy(installLine(p, pkgVersions));
    return `dpkg -l ${p} 2>/dev/null | grep -q "^ii" && echo "[CX] ${p} already installed, skipping." || ${install}`;
  }).join('\n');
  const feedLine = sudofy(feedSedLine(feed));
  const _rtInstall1 = sudofy(installLine('tc31-xar-um', pkgVersions));
  const runtimeLine1 = `dpkg -l tc31-xar-um 2>/dev/null | grep -q "^ii" && echo "[CX] tc31-xar-um already installed, skipping." || ${_rtInstall1}`;
  const _rtInstall2 = sudofy(installLine('console-setup', pkgVersions));
  const runtimeLine2 = `dpkg -l console-setup 2>/dev/null | grep -q "^ii" && echo "[CX] console-setup already installed, skipping." || ${_rtInstall2}`;

  const hmiBlock = pkgs.includes('tf2000-hmi-server')
    ? `
echo "[CX] Checking TF2000 HMI Server..."
if _sudo test -f /etc/TwinCAT/Functions/TF2000-HMI-Server/TcHmiSrv.cfg 2>/dev/null || _sudo systemctl is-active TcHmiSrv.service &>/dev/null; then
  echo "[CX] TF2000 already initialized — skipping init, ensuring service is running."
  _sudo systemctl enable TcHmiSrv.service || true
  _sudo systemctl start TcHmiSrv.service || true
else
  echo "[CX] Initializing TF2000 HMI Server..."
  _sudo TcHmiSrv --initialize --password=${tf2000Pass}
  _sudo systemctl enable TcHmiSrv.service
  _sudo systemctl start TcHmiSrv.service
fi`
    : '';

  const tf1200Block = pkgs.includes('tf1200-ui-client')
    ? `
echo "[CX] Configuring TF1200-UI-Client..."
cd /etc/TwinCAT/Functions/TF1200-UI-Client/scripts
_sudo ./setup-full.sh --user=TF1200 --autologin --autostart
_sudo sh -c 'echo "TF1200:1" | chpasswd'
_sudo usermod -aG sudo TF1200`
    : '';

  const mdpBlock = pkgs.includes('mdp-bhf') ? '\n_sudo systemctl daemon-reload' : '';
  const pkgsBlock = pkgs.length
    ? `echo "[CX] Installing optional packages..."\n${pkgLines}`
    : '# No optional packages selected';

  return `#!/bin/bash
# Inner setup script — executed by the Electron app over SSH.
# Positional args: $1 = MyBeckhoff username, $2 = MyBeckhoff password,
#                  $3 = Administrator password (for sudo).
set -e
BECKHOFF_USER="$1"
BECKHOFF_PASS="$2"
SUDO_PASS="$3"

if [ -z "$BECKHOFF_USER" ] || [ -z "$BECKHOFF_PASS" ] || [ -z "$SUDO_PASS" ]; then
  echo "[CX] ERROR: Missing credentials (usage: \$0 BK_USER BK_PASS SUDO_PASS)" >&2
  exit 2
fi

#  Quiet down apt — suppress the fancy cursor-based progress bar ─
# Tell apt to skip its ncurses-style progress redraws; tell apt not to emit
# download-progress bars or dialog frontends. All three combined produce clean
# line-oriented output that renders cleanly in the Electron terminal pane
# without needing a full VT100 emulator on the client.
export TERM=dumb
export DEBIAN_FRONTEND=noninteractive
export DEBCONF_NONINTERACTIVE_SEEN=true
APT_OPTS='-o Dpkg::Progress-Fancy=0 -o Dpkg::Use-Pty=0 -o APT::Color=0 -o Quiet::NoUpdate=true'

# ── sudo wrapper: feed password on stdin (-S), keep credentials cached (-v) ──
_sudo() { echo "$SUDO_PASS" | sudo -S -p '' "$@"; }
# Prime sudo's timestamp so subsequent calls don't re-prompt within 5-15 min
_sudo -v

echo "[CX] Creating APT auth file..."
AUTH_TMP=$(mktemp)
printf 'machine deb.beckhoff.com\nlogin %s\npassword %s\nmachine deb-mirror.beckhoff.com\nlogin %s\npassword %s\n' \\
  "$BECKHOFF_USER" "$BECKHOFF_PASS" "$BECKHOFF_USER" "$BECKHOFF_PASS" > "$AUTH_TMP"
_sudo mkdir -p /etc/apt/auth.conf.d
_sudo mv "$AUTH_TMP" /etc/apt/auth.conf.d/bhf.conf
_sudo chmod 600 /etc/apt/auth.conf.d/bhf.conf
_sudo chown root:root /etc/apt/auth.conf.d/bhf.conf

# Sanity — print credential lengths so truncation/corruption shows up in logs
echo "[CX] Auth file written: user=\${#BECKHOFF_USER} chars, pass=\${#BECKHOFF_PASS} chars"
echo "[CX] Auth file preview (password masked):"
_sudo sed 's/^password .*/password ***MASKED***/' /etc/apt/auth.conf.d/bhf.conf

${feedLine}
echo "[CX] Updating package lists..."
_sudo apt $APT_OPTS update -y
echo "[CX] Disabling firewall..."
_sudo systemctl stop nftables || true
_sudo systemctl disable nftables || true
echo "[CX] Installing console-setup..."
# debconf-set-selections needs data on stdin — but so does sudo -S for the
# password. Wrap both in a single "sh -c" so _sudo's stdin carries only the
# password, and the debconf data is piped inside the elevated shell.
_sudo sh -c 'echo "keyboard-configuration keyboard-configuration/layoutcode string us" | debconf-set-selections'
_sudo sh -c 'echo "console-setup console-setup/codeset47 select Guess optimal character set" | debconf-set-selections'
${runtimeLine2}
echo "[CX] Installing TwinCAT runtime..."
${runtimeLine1}
${pkgsBlock}${mdpBlock}${hmiBlock}${tf1200Block}
echo "[CX] Upgrading all packages..."
_sudo apt $APT_OPTS upgrade -y
echo "[CX] Setup complete! Rebooting in 5 seconds..."
sleep 5
_sudo reboot
`;
}

//  INNER: TF1Arsenal00 config (runs on CX as /tmp/tf1200_configure.sh $1 $2) 
function buildInnerTF1200Script({ jsonConfig = {} } = {}) {
  const jqExpr = buildJqExpr(jsonConfig);

  return `#!/bin/bash
# Inner TF1200 config script — executed over SSH by the Electron app.
# Positional args: $1 = HMI_URL, $2 = Administrator password (for sudo).
set -e
HMI_URL="$1"
SUDO_PASS="$2"
CONFIG_FILE="/home/TF1200/.config/TF1200-UI-Client/config.json"

if [ -z "$SUDO_PASS" ]; then
  echo "[CX] ERROR: Missing sudo password (usage: \$0 HMI_URL SUDO_PASS)" >&2
  exit 2
fi

export TERM=dumb
export DEBIAN_FRONTEND=noninteractive
export DEBCONF_NONINTERACTIVE_SEEN=true
APT_OPTS='-o Dpkg::Progress-Fancy=0 -o Dpkg::Use-Pty=0 -o APT::Color=0 -o Quiet::NoUpdate=true'

# ── sudo wrapper: feed password on stdin (-S), keep credentials cached (-v) ──
_sudo() { echo "$SUDO_PASS" | sudo -S -p '' "$@"; }
# Prime sudo's timestamp so subsequent calls don't re-prompt within 5-15 min
_sudo -v

if ! id "TF1200" &>/dev/null; then
  echo "[CX] ERROR: TF1200 user missing. Run full setup first." >&2
  exit 1
fi
if ! _sudo test -f "$CONFIG_FILE"; then
  echo "[CX] ERROR: Config not found at $CONFIG_FILE" >&2
  _sudo ls -la /home/TF1200/.config/TF1200-UI-Client/ || true
  exit 1
fi

command -v jq &>/dev/null || _sudo apt $APT_OPTS install -y jq
BACKUP="\${CONFIG_FILE}.backup.\$(date +%Y%m%d_%H%M%S)"
_sudo cp "$CONFIG_FILE" "$BACKUP"
echo "[CX] Backup: $BACKUP"
echo "[CX] Previous startUrl: $(_sudo jq -r '.startUrl' $CONFIG_FILE)"

_sudo jq --arg url "$HMI_URL" \\
     '${jqExpr}' \\
     "$CONFIG_FILE" > /tmp/config.json.tmp
_sudo mv /tmp/config.json.tmp "$CONFIG_FILE"
_sudo chown TF1200:TF1200 "$CONFIG_FILE"
_sudo chmod 644 "$CONFIG_FILE"

echo "[CX] New configuration:"
_sudo jq '{startUrl,enableKioskMode,commandLineSwitches,enableDevTools,enableMenuBar}' "$CONFIG_FILE"
echo "[CX] Config updated. Rebooting in 5s..."
sleep 5
_sudo reboot
`;
}

// Build the `jq` update expression from the JSON config editor state.
// Exact semantics preserved from the original HTML buildTF1200Script().
function buildJqExpr(jsonConfig) {
  const parts = [];
  for (const [key, cfg] of Object.entries(jsonConfig)) {
    if (!cfg) continue;
    if (key === 'commandLineSwitches') {
      parts.push(`.${key} = ${JSON.stringify(cfg.value || [])}`);
    } else if (cfg.type === 'bool') {
      parts.push(`.${key} = ${cfg.value ? 'true' : 'false'}`);
    } else if (cfg.type === 'num') {
      parts.push(`.${key} = ${Number(cfg.value)}`);
    } else if (cfg.type === 'text') {
      if (key === 'startUrl') {
        parts.push(`.startUrl = $url`);
      } else {
        parts.push(`.${key} = ${JSON.stringify(cfg.value || '')}`);
      }
    } else if (cfg.type === 'tags') {
      parts.push(`.${key} = ${JSON.stringify(cfg.value || [])}`);
    }
  }
  return parts.join(' |\n     ');
}

//FULL: setup.sh (the Copy/Download button output) 
function buildFullSetupScript(opts = {}) {
  const {
    cxIp = '<CX_IP>',
    cxPass = '1',
    beckhoffUser = '<BECKHOFF_USER>',
    beckhoffPass = '<BECKHOFF_PASS>',
    feed = 'trixie-stable',
    packages = [],
    pkgVersions = {},
    tf2000Pass = '1'
  } = opts;

  const pkgs = Array.isArray(packages) ? packages : [];
  const inner = buildInnerSetupScript({ feed, packages, pkgVersions, tf2000Pass });
  const hasTF1200 = pkgs.includes('tf1200-ui-client');

  return `#!/usr/bin/env bash
#
# TwinCAT Linux Automated Setup Script
# Generated by TwinCAT Setup Console
# Feed: ${feed}
# Packages: tc31-xar-um${pkgs.length ? ', ' + pkgs.join(', ') : ' (runtime only)'}
#
set +e
RED='\\033[0;31m'; GREEN='\\033[0;32m'; YELLOW='\\033[1;33m'; NC='\\033[0m'
log_info(){ echo -e "\${GREEN}[INFO]\${NC} $1"; }
log_warn(){ echo -e "\${YELLOW}[WARN]\${NC} $1"; }
log_error(){ echo -e "\${RED}[ERROR]\${NC} $1"; }
pause_before_exit(){ echo ""; read -p "Press Enter to exit..."; exit $1; }
trap 'log_error "Script failed at line $LINENO. Exit code: $?"; pause_before_exit 1' ERR

CX_IP="${cxIp}"
CX_PASS="${cxPass}"
BECKHOFF_USER="${beckhoffUser}"
BECKHOFF_PASS="${beckhoffPass}"

# ── sshpass auto-detection (not available on Windows / Git Bash) ──────────────
if command -v sshpass &>/dev/null; then
  log_info "sshpass found — passwords will be supplied automatically"
  _ssh() { sshpass -p "$CX_PASS" ssh "$@"; }
  _scp() { sshpass -p "$CX_PASS" scp "$@"; }
else
  log_warn "sshpass not found (Git Bash / Windows detected)"
  log_warn "You will be prompted for the Administrator password: $CX_PASS"
  log_warn "Enter it each time the prompt appears — it will not echo"
  _ssh() { ssh "$@"; }
  _scp() { scp "$@"; }
fi

echo "========================================"
echo "  TwinCAT Linux Automated Setup"
echo "  Feed  : ${feed}"
echo "  Target: $CX_IP"
echo "========================================"
echo ""

ssh-keygen -R $CX_IP 2>/dev/null || true
log_info "Testing SSH connection to $CX_IP..."
if ! _ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 Administrator@$CX_IP "echo OK"; then
  log_error "SSH failed. Check: correct IP? CX powered on? Password correct ($CX_PASS)?"
  pause_before_exit 1
fi
log_info "SSH OK. Uploading setup script..."

TEMP_SCRIPT=$(mktemp)
cat > "$TEMP_SCRIPT" <<'ENDSCRIPT'
${inner}ENDSCRIPT

_scp -o StrictHostKeyChecking=no "$TEMP_SCRIPT" Administrator@$CX_IP:/tmp/twincat_setup.sh
log_info "Executing on CX — this will take 10-15 minutes. Do not interrupt!"
_ssh -t -t -o StrictHostKeyChecking=no Administrator@$CX_IP \\
  "chmod +x /tmp/twincat_setup.sh && /tmp/twincat_setup.sh '$BECKHOFF_USER' '$BECKHOFF_PASS' '$CX_PASS'"
rm "$TEMP_SCRIPT"
log_info "CX is rebooting. Wait ~40s then reconnect."
log_info "SSH: Administrator@${cxIp} (password: $CX_PASS)"
${hasTF1200 ? `log_info "SSH: TF1200@${cxIp} (password: 1)"` : ''}
pause_before_exit 0
`;
}

//FULL: tf1200-config.sh (the Copy/Download button output)
function buildFullTF1200Script(opts = {}) {
  const {
    cxIp = '<CX_IP>',
    cxPass = '1',
    hmiUrl = '<HMI_URL>',
    jsonConfig = {}
  } = opts;

  const inner = buildInnerTF1200Script({ jsonConfig });

  const cfgSummary = Object.entries(jsonConfig)
    .map(([k, v]) => {
      if (!v) return `#   ${k}: (unset)`;
      if (v.type === 'tags') return `#   ${k}: [${(v.value || []).join(', ')}]`;
      return `#   ${k}: ${JSON.stringify(v.value)}`;
    }).join('\n');

  return `#!/usr/bin/env bash
#
# TF1200-UI-Client Configuration Script
# Generated by TwinCAT Setup Console
#
# Applied JSON settings:
${cfgSummary}
#
set +e
RED='\\033[0;31m'; GREEN='\\033[0;32m'; YELLOW='\\033[1;33m'; NC='\\033[0m'
log_info(){ echo -e "\${GREEN}[INFO]\${NC} $1"; }
log_warn(){ echo -e "\${YELLOW}[WARN]\${NC} $1"; }
log_error(){ echo -e "\${RED}[ERROR]\${NC} $1"; }
pause_before_exit(){ echo ""; read -p "Press Enter to exit..."; exit $1; }
trap 'log_error "Script failed at line $LINENO. Exit code: $?"; pause_before_exit 1' ERR

CX_IP="${cxIp}"
CX_PASS="${cxPass}"
HMI_URL="${hmiUrl}"

if command -v sshpass &>/dev/null; then
  log_info "sshpass found — passwords will be supplied automatically"
  _ssh() { sshpass -p "$CX_PASS" ssh "$@"; }
  _scp() { sshpass -p "$CX_PASS" scp "$@"; }
else
  log_warn "sshpass not found (Git Bash / Windows detected)"
  log_warn "You will be prompted for the Administrator password: $CX_PASS"
  log_warn "Enter it each time the prompt appears — it will not echo"
  _ssh() { ssh "$@"; }
  _scp() { scp "$@"; }
fi

echo "========================================"
echo "  TF1200-UI-Client Configuration"
echo "  Target : $CX_IP"
echo "  HMI URL: $HMI_URL"
echo "========================================"

log_info "Testing SSH connection..."
if ! _ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 Administrator@$CX_IP "echo OK"; then
  log_error "Cannot connect to $CX_IP (password: $CX_PASS)"; pause_before_exit 1
fi

TEMP_SCRIPT=$(mktemp)
cat > "$TEMP_SCRIPT" <<'ENDSCRIPT'
${inner}ENDSCRIPT

_scp -o StrictHostKeyChecking=no "$TEMP_SCRIPT" Administrator@$CX_IP:/tmp/tf1200_configure.sh
_ssh -t -t -o StrictHostKeyChecking=no Administrator@$CX_IP \\
  "chmod +x /tmp/tf1200_configure.sh && /tmp/tf1200_configure.sh '$HMI_URL' '$CX_PASS'"
rm "$TEMP_SCRIPT"
log_info "Applied all config settings to TF1200."
log_info "CX rebooting — connect monitor to see TF1200 UI Client load."
log_info ""
log_info "Troubleshooting:"
log_info "  ssh TF1200@$CX_IP 'cat ~/.config/TF1200-UI-Client/config.json'"
log_info "  ssh Administrator@$CX_IP 'sudo ls /home/TF1200/.config/TF1200-UI-Client/*.backup*'"
pause_before_exit 0
`;
}

module.exports = {
  buildInnerSetupScript,
  buildInnerTF1200Script,
  buildFullSetupScript,
  buildFullTF1200Script
};
