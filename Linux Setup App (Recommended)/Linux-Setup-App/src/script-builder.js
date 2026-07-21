// If you're redaidn this send help... JavaScript will be the end of me... 
// src/script-builder.js - builds shell scripts for the CX
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
// Single-quote a value for safe use inside a generated shell script
function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function installLine(name, pkgVersions) {
  const v = pkgVersions && pkgVersions[name];
  if (v && v.mode === 'pinned' && v.version) {
    return `sudo apt $APT_OPTS install -y ${name}=${v.version}`;
  }
  return `sudo apt $APT_OPTS install -y ${name}`;
}

function feedSedLine(feed) {
  // Always write the exact desired feed explicitly rather than using sed.
  // The sed approach only worked stable→unstable and silently did nothing
  // when switching back (unstable→stable), because there was no reverse path.
  // Overwriting the file is idempotent in all four directions and doesn't
  // depend on what the file currently contains.
  const channel = feed === 'trixie-stable' ? 'trixie-stable' : 'trixie-unstable';
  return `_sudo bash -c 'printf "deb [signed-by=/usr/share/keyrings/bhf.asc] https://deb.beckhoff.com/debian ${channel} main\\n" > /etc/apt/sources.list.d/bhf.list'
echo "[CX] APT feed set to: ${channel}"`;
}

// Snapshots whether a package was already installed before this script's own
// apt install runs. No sudo needed, dpkg -l is a plain query. Used to tell a
// genuinely fresh install apart from a re-run against an already-set-up CX.
function buildWasInstalledSnippet(pkgName, varName) {
  return `${varName}=no; dpkg -l ${pkgName} 2>/dev/null | grep -q "^ii" && ${varName}=yes`;
}

// Brings up TF2000 HMI Server safely after install. Only skips --initialize
// when the package was genuinely already installed before this run AND its
// service instance directory already exists - /var/lib/tchmisrv/service/
// TcHmiProject is what TcHmiSrv itself creates on a real initialize (confirmed
// from its own output: "Adding service instance /var/lib/.../TcHmiProject"),
// not a guessed path. An earlier version of this check used a wrong path that
// never matched, so a re-run against an already-initialized CX always fell
// through to attempting init again - which then genuinely fails, since the
// server really is already running. As a second line of defense in case that
// directory check ever misses a real case, a failed --initialize is only
// treated as fatal if it isn't specifically the "already running" error -
// that one just means it's already up, which is exactly what we wanted.
// wasInstalledVar names a shell variable (from buildWasInstalledSnippet)
// holding "yes"/"no".
function buildTf2000InitBlock(tf2000Pass, wasInstalledVar) {
  return `
echo "[CX] Checking TF2000 HMI Server..."
if [ "$${wasInstalledVar}" = "yes" ] && _sudo test -d /var/lib/tchmisrv/service/TcHmiProject 2>/dev/null; then
  echo "[CX] TF2000 already initialized - skipping init, ensuring service is running."
  _sudo systemctl enable TcHmiSrv.service || true
  _sudo systemctl start TcHmiSrv.service || true
else
  echo "[CX] Initializing TF2000 HMI Server..."
  set +e
  TF2000_INIT_OUT=$(_sudo TcHmiSrv --initialize --password=${shq(tf2000Pass)} 2>&1)
  TF2000_INIT_CODE=$?
  set -e
  echo "$TF2000_INIT_OUT"
  if [ $TF2000_INIT_CODE -ne 0 ]; then
    if echo "$TF2000_INIT_OUT" | grep -q "HMI_E_SERVER_ALREADY_RUNNING"; then
      echo "[CX] TF2000 was already initialized (server already running) - continuing."
    else
      exit $TF2000_INIT_CODE
    fi
  fi
  _sudo systemctl enable TcHmiSrv.service
  _sudo systemctl start TcHmiSrv.service
fi`;
}

// Creates and configures the TF1200 Linux user: home directory, autologin,
// kiosk autostart, password, sudo. Without this, tf1200-ui-client installs as
// a package with nothing behind it - no user to log into, no config.json
// directory ever created, and no autologin means the CX sits at a login/splash
// screen on reboot instead of loading the kiosk.
function buildTf1200UserSetupBlock() {
  return `
echo "[CX] Configuring TF1200-UI-Client..."
cd /etc/TwinCAT/Functions/TF1200-UI-Client/scripts
_sudo ./setup-full.sh --user=TF1200 --autologin --autostart
_sudo sh -c 'echo "TF1200:1" | chpasswd'
_sudo usermod -aG sudo TF1200`;
}

//INNER: full setup (runs on CX as /tmp/twincat_setup.sh $1 $2 $3)
function buildInnerSetupScript({ feed = 'trixie-stable', packages = [], pkgVersions = {}, tf2000Pass = '1', proxyHost = null, proxyPort = null } = {}) {
  const pkgs = Array.isArray(packages) ? packages : [];
  // If a SOCKS5 proxy was offered and accepted (CX has no internet route of its
  // own), thread it into APT_OPTS once - every apt call below already goes
  // through $APT_OPTS, so this single line covers update/install/upgrade alike.
  // socks5h (not socks5) so hostname resolution happens at the proxy (laptop
  // side), since that's the whole point - the CX can't resolve it itself.
  const proxyOpts = (proxyHost && proxyPort)
    ? ` -o Acquire::http::Proxy=socks5h://${proxyHost}:${proxyPort}/ -o Acquire::https::Proxy=socks5h://${proxyHost}:${proxyPort}/`
    : '';
  // Swap all "sudo " → "_sudo " in package install / feed / helper lines so
  // every elevated command goes through the password-feeding wrapper.
  const sudofy = (s) => s.replace(/(^|\s|\|)sudo /g, '$1_sudo ');

  const pkgLines = pkgs.map((p) => {
    const install = sudofy(installLine(p, pkgVersions));
    return `dpkg -l ${p} 2>/dev/null | grep -q "^ii" && echo "[CX] ${p} already installed, skipping." || ${install}`;
  }).join('\n');
  const feedLine = sudofy(feedSedLine(feed));

  const tf2000PreCheckBlock = pkgs.includes('tf2000-hmi-server')
    ? `\n${buildWasInstalledSnippet('tf2000-hmi-server', 'TF2000_WAS_INSTALLED')}\n`
    : '';

  const hmiBlock = pkgs.includes('tf2000-hmi-server')
    ? buildTf2000InitBlock(tf2000Pass, 'TF2000_WAS_INSTALLED')
    : '';

  const tf1200Block = pkgs.includes('tf1200-ui-client')
    ? buildTf1200UserSetupBlock()
    : '';

  const mdpBlock = pkgs.includes('mdp-bhf') ? '\n_sudo systemctl daemon-reload' : '';
  const pkgsBlock = pkgs.length
    ? `echo "[CX] Installing optional packages..."\n${pkgLines}`
    : '# No optional packages selected';

  return `#!/bin/bash
# Inner setup script - executed by the Electron app over SSH.
# Positional args: $1 = MyBeckhoff username, $2 = MyBeckhoff password,
#                  $3 = Administrator password (for sudo).
# $1/$2 may be blank if bhf.conf already exists on the CX - see check below.
set -e
trap 'rm -f "$0"' EXIT
BECKHOFF_USER="$1"
BECKHOFF_PASS="$2"
SUDO_PASS="$3"

if [ -z "$SUDO_PASS" ]; then
  echo "[CX] ERROR: Missing Administrator password (usage: \$0 BK_USER BK_PASS SUDO_PASS)" >&2
  exit 2
fi

#  Quiet down apt - suppress the fancy cursor-based progress bar ─
# Tell apt to skip its ncurses-style progress redraws; tell apt not to emit
# download-progress bars or dialog frontends. All three combined produce clean
# line-oriented output that renders cleanly in the Electron terminal pane
# without needing a full VT100 emulator on the client.
export TERM=dumb
export DEBIAN_FRONTEND=noninteractive
export DEBCONF_NONINTERACTIVE_SEEN=true
APT_OPTS='-o Dpkg::Progress-Fancy=0 -o Dpkg::Use-Pty=0 -o APT::Color=0 -o Quiet::NoUpdate=true${proxyOpts}'

# ── sudo wrapper: feed password on stdin (-S), keep credentials cached (-v) ──
_sudo() { echo "$SUDO_PASS" | sudo -S -p '' "$@"; }
# Prime sudo's timestamp so subsequent calls don't re-prompt within 5-15 min
_sudo -v

# Skip rewriting the auth file if MyBeckhoff creds are already on the CX -
# this is what lets the UI run setup again without retyping the password.
if _sudo test -s /etc/apt/auth.conf.d/bhf.conf; then
  echo "[CX] MyBeckhoff auth file already present on CX - reusing existing credentials."
elif [ -n "$BECKHOFF_USER" ] && [ -n "$BECKHOFF_PASS" ]; then
  echo "[CX] Creating APT auth file..."
  AUTH_TMP=$(mktemp)
  printf 'machine deb.beckhoff.com\nlogin %s\npassword %s\nmachine deb-mirror.beckhoff.com\nlogin %s\npassword %s\n' \\
    "$BECKHOFF_USER" "$BECKHOFF_PASS" "$BECKHOFF_USER" "$BECKHOFF_PASS" > "$AUTH_TMP"
  _sudo mkdir -p /etc/apt/auth.conf.d
  _sudo mv "$AUTH_TMP" /etc/apt/auth.conf.d/bhf.conf
  _sudo chmod 600 /etc/apt/auth.conf.d/bhf.conf
  _sudo chown root:root /etc/apt/auth.conf.d/bhf.conf
  # Sanity - print credential lengths so truncation/corruption shows up in logs
  echo "[CX] Auth file written: user=\${#BECKHOFF_USER} chars, pass=\${#BECKHOFF_PASS} chars"
  echo "[CX] Auth file preview (password masked):"
  _sudo sed 's/^password .*/password ***MASKED***/' /etc/apt/auth.conf.d/bhf.conf
else
  echo "[CX] ERROR: No MyBeckhoff auth file on CX and no credentials provided (usage: \$0 BK_USER BK_PASS SUDO_PASS)" >&2
  exit 2
fi

${feedLine}
echo "[CX] Updating package lists..."
_sudo apt $APT_OPTS update -y
echo "[CX] Saving current firewall state before setup..."
FW_WAS_ACTIVE=$(_sudo systemctl is-active nftables 2>/dev/null || true)
FW_WAS_ACTIVE=\${FW_WAS_ACTIVE:-inactive}
FW_WAS_ENABLED=$(_sudo systemctl is-enabled nftables 2>/dev/null || true)
FW_WAS_ENABLED=\${FW_WAS_ENABLED:-disabled}
if [ "$FW_WAS_ACTIVE" = "active" ]; then
  # Capture the actual ruleset, not just whether the service was on - a
  # package's own install can silently overwrite the firewall's persisted
  # config while it's disabled below, and nothing else here would notice.
  # Restoring service state alone would then just re-launch nftables against
  # whatever got left behind.
  _sudo nft list ruleset > /tmp/fw_backup.nft 2>/dev/null || true
fi
echo "[CX] Disabling firewall for setup..."
_sudo systemctl stop nftables || true
_sudo systemctl disable nftables || true
echo "[CX] Installing console-setup..."
# debconf-set-selections needs data on stdin - but so does sudo -S for the
# password. Wrap both in a single "sh -c" so _sudo's stdin carries only the
# password, and the debconf data is piped inside the elevated shell.
#
# keyboard-configuration/layout and console-setup/charmap47 are separate
# follow-up questions from layoutcode/codeset47 respectively (the "which
# family" vs "which specific option within it" pattern debconf uses here) -
# missing either one is enough to leave an interactive prompt waiting for
# input that will never come over a plain SSH exec.
_sudo sh -c 'echo "keyboard-configuration keyboard-configuration/layout select English (US)" | debconf-set-selections'
_sudo sh -c 'echo "keyboard-configuration keyboard-configuration/layoutcode string us" | debconf-set-selections'
_sudo sh -c 'echo "console-setup console-setup/codeset47 select Guess optimal character set" | debconf-set-selections'
_sudo sh -c 'echo "console-setup console-setup/charmap47 select UTF-8" | debconf-set-selections'
if dpkg -l console-setup 2>/dev/null | grep -q "^ii"; then
  echo "[CX] console-setup already installed, skipping."
else
  # set -e is active for this whole script - temporarily suspend it around
  # this one command so a timeout or failure here degrades gracefully with a
  # clear message instead of silently killing the entire Setup run before it
  # ever reaches TwinCAT itself.
  set +e
  echo "$SUDO_PASS" | timeout 180 sudo -S -p '' apt $APT_OPTS install -y console-setup
  CONSOLE_SETUP_RC=$?
  set -e
  if [ "$CONSOLE_SETUP_RC" -eq 124 ]; then
    echo "[CX] WARNING: console-setup install timed out after 180s, likely an interactive prompt that wasn't fully suppressed. Continuing setup - install it manually later via Shell (sudo apt install console-setup) if needed."
  elif [ "$CONSOLE_SETUP_RC" -ne 0 ]; then
    echo "[CX] WARNING: console-setup install failed (exit $CONSOLE_SETUP_RC). Continuing setup."
  fi
fi
${tf2000PreCheckBlock}${pkgsBlock}${mdpBlock}${hmiBlock}${tf1200Block}
echo "[CX] Checking for available system upgrades..."
UPGRADABLE_COUNT=$(apt list --upgradable 2>/dev/null | grep -v '^Listing' | wc -l)
if [ "$UPGRADABLE_COUNT" -gt 0 ]; then
  echo "[CX] $UPGRADABLE_COUNT system package(s) can be upgraded. Not applied automatically - review and install them from the Packages page."
else
  echo "[CX] No system package upgrades available."
fi
echo "[CX] Restoring firewall to its state before setup (was active=$FW_WAS_ACTIVE, enabled=$FW_WAS_ENABLED)..."
if [ "$FW_WAS_ACTIVE" = "active" ] && [ -s /tmp/fw_backup.nft ]; then
  echo "[CX] Re-applying the pre-setup firewall ruleset..."
  _sudo nft -f /tmp/fw_backup.nft
  _sudo sh -c 'nft list ruleset | tee /etc/nftables-bhf.conf' >/dev/null
fi
_sudo rm -f /tmp/fw_backup.nft
if [ "$FW_WAS_ENABLED" = "enabled" ]; then
  _sudo systemctl enable nftables || true
else
  _sudo systemctl disable nftables || true
fi
if [ "$FW_WAS_ACTIVE" = "active" ]; then
  _sudo systemctl start nftables || true
else
  _sudo systemctl stop nftables || true
fi
echo "[CX] Setup complete! Rebooting in 5 seconds..."
sleep 5
_sudo reboot
`;
}

//  INNER: TF1Arsenal00 config (runs on CX as /tmp/tf1200_configure.sh $1 $2) 
function buildInnerTF1200Script({ jsonConfig = {}, proxyHost = null, proxyPort = null } = {}) {
  const jqExpr = buildJqExpr(jsonConfig);
  const proxyOpts = (proxyHost && proxyPort)
    ? ` -o Acquire::http::Proxy=socks5h://${proxyHost}:${proxyPort}/ -o Acquire::https::Proxy=socks5h://${proxyHost}:${proxyPort}/`
    : '';

  return `#!/bin/bash
# Inner TF1200 config script - executed over SSH by the Electron app.
# Positional args: $1 = HMI_URL, $2 = Administrator password (for sudo).
set -e
trap 'rm -f "$0"' EXIT
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
APT_OPTS='-o Dpkg::Progress-Fancy=0 -o Dpkg::Use-Pty=0 -o APT::Color=0 -o Quiet::NoUpdate=true${proxyOpts}'

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
# Packages: ${pkgs.length ? pkgs.join(', ') : '(none selected)'}
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
  log_info "sshpass found - passwords will be supplied automatically"
  _ssh() { sshpass -p "$CX_PASS" ssh "$@"; }
  _scp() { sshpass -p "$CX_PASS" scp "$@"; }
else
  log_warn "sshpass not found (Git Bash / Windows detected)"
  log_warn "You will be prompted for the Administrator password: $CX_PASS"
  log_warn "Enter it each time the prompt appears - it will not echo"
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
log_info "Executing on CX - this will take 10-15 minutes. Do not interrupt!"
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
  log_info "sshpass found - passwords will be supplied automatically"
  _ssh() { sshpass -p "$CX_PASS" ssh "$@"; }
  _scp() { sshpass -p "$CX_PASS" scp "$@"; }
else
  log_warn "sshpass not found (Git Bash / Windows detected)"
  log_warn "You will be prompted for the Administrator password: $CX_PASS"
  log_warn "Enter it each time the prompt appears - it will not echo"
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
log_info "CX rebooting - connect monitor to see TF1200 UI Client load."
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
  buildFullTF1200Script,
  buildWasInstalledSnippet,
  buildTf2000InitBlock,
  buildTf1200UserSetupBlock
};