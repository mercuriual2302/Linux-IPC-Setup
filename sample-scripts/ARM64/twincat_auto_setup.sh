#!/usr/bin/env bash
#
# TwinCAT Linux Automated Setup Script
# Automates CX9240 setup from SSH connection through TF1200-UI-Client configuration
#

# Don't exit on error immediately - we'll handle errors ourselves
set +e

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored messages
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to pause before exit (Windows compatibility)
pause_before_exit() {
    echo ""
    read -p "Press Enter to exit..."
    exit $1
}

# Trap errors
trap 'log_error "Script failed at line $LINENO. Exit code: $?"; pause_before_exit 1' ERR

# Function to prompt for input
prompt_input() {
    local prompt_msg="$1"
    local var_name="$2"
    local is_password="$3"
    
    if [ "$is_password" = "true" ]; then
        read -s -p "$prompt_msg" $var_name
        echo
    else
        read -p "$prompt_msg" $var_name
    fi
}

# Main script starts here
echo "========================================"
echo "  TwinCAT Linux Automated Setup"
echo "========================================"
echo

# Check if running in Git Bash or similar on Windows
if [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then
    log_warn "Detected Windows environment (Git Bash/Cygwin)"
    log_warn "SSH password prompts work best in this environment"
fi

# Prompt for CX IP address
prompt_input "Enter the IP address of the CX: " CX_IP false

if [ -z "$CX_IP" ]; then
    log_error "IP address cannot be empty!"
    pause_before_exit 1
fi

# Prompt for myBeckhoff credentials
echo
log_info "Enter your myBeckhoff credentials for APT repository access:"
prompt_input "  Username: " BECKHOFF_USER false
prompt_input "  Password: " BECKHOFF_PASS true

if [ -z "$BECKHOFF_USER" ] || [ -z "$BECKHOFF_PASS" ]; then
    log_error "Credentials cannot be empty!"
    pause_before_exit 1
fi

# Confirm inputs
echo
echo "Configuration Summary:"
echo "  CX IP Address: $CX_IP"
echo "  Beckhoff Username: $BECKHOFF_USER"
echo
read -p "Continue with these settings? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    log_error "Setup cancelled by user."
    pause_before_exit 0
fi

log_info "Removing any existing SSH host keys for $CX_IP..."
ssh-keygen -R $CX_IP 2>/dev/null || true

log_info "Connecting to CX at $CX_IP..."
log_warn "You will be prompted for the Administrator password (default: 1)"
echo ""

# Test SSH connection first
log_info "Testing SSH connection..."
if ! ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 Administrator@$CX_IP "echo 'Connection test successful'" ; then
    log_error "Failed to connect to $CX_IP"
    log_error "Please check:"
    log_error "  1. IP address is correct"
    log_error "  2. CX is powered on and network connected"
    log_error "  3. You entered the correct password (default is: 1)"
    pause_before_exit 1
fi

log_info "SSH connection successful! Starting setup..."
echo ""

# Create a temporary script file to upload
TEMP_SCRIPT=$(mktemp)
cat > "$TEMP_SCRIPT" <<'ENDSCRIPT'
#!/bin/bash
set -e

echo "[CX] =========================================="
echo "[CX] Starting TwinCAT Setup on Remote System"
echo "[CX] =========================================="
echo ""

# Get credentials from arguments
BECKHOFF_USER="$1"
BECKHOFF_PASS="$2"

# Create APT auth configuration with provided credentials
echo "[CX] Creating APT authentication file..."
sudo tee /etc/apt/auth.conf.d/bhf.conf > /dev/null <<EOF
machine deb.beckhoff.com
login $BECKHOFF_USER
password $BECKHOFF_PASS

machine deb-mirror.beckhoff.com
login $BECKHOFF_USER
password $BECKHOFF_PASS
EOF

# Secure the auth file - only root can read
echo "[CX] Securing authentication file permissions..."
sudo chmod 600 /etc/apt/auth.conf.d/bhf.conf
sudo chown root:root /etc/apt/auth.conf.d/bhf.conf


# Switch to unstable feed
# echo "[CX] Configuring APT sources for unstable feed..."
# sudo sed -i 's/trixie-stable/trixie-unstable/g' /etc/apt/sources.list.d/bhf.list

# Update package lists
echo "[CX] Updating package lists..."
sudo apt update -y

# Disable firewall
echo "[CX] Disabling firewall..."
sudo systemctl stop nftables || true
sudo systemctl disable nftables || true

# Install console-setup (auto-answer prompts)
echo "[CX] Installing console-setup..."
echo "keyboard-configuration keyboard-configuration/layoutcode string us" | sudo debconf-set-selections
echo "console-setup console-setup/codeset47 select Guess optimal character set" | sudo debconf-set-selections
sudo DEBIAN_FRONTEND=noninteractive apt install -y console-setup

# Install TwinCAT runtime
echo "[CX] Installing TwinCAT runtime (tc31-xar-um)..."
sudo DEBIAN_FRONTEND=noninteractive apt install -y tc31-xar-um

# Install TwinCAT Functions
echo "[CX] Installing TwinCAT Functions (this may take a few minutes)..."
sudo DEBIAN_FRONTEND=noninteractive apt install -y tf5000-nc-ptp-xar
sudo DEBIAN_FRONTEND=noninteractive apt install -y mdp-bhf
sudo DEBIAN_FRONTEND=noninteractive apt install -y tc31-xar-multiconfigcoupler
sudo DEBIAN_FRONTEND=noninteractive apt install -y tf6421-xml-server
sudo DEBIAN_FRONTEND=noninteractive apt install -y tf6250-modbus-tcp

# Reload systemd after mdp-bhf update
echo "[CX] Reloading systemd daemon..."
sudo systemctl daemon-reload

# Install TF2000 HMI Server
echo "[CX] Installing TF2000 HMI Server..."
sudo DEBIAN_FRONTEND=noninteractive apt install -y tf2000-hmi-server

# Initialize HMI Server
echo "[CX] Initializing TF2000 HMI Server..."
sudo TcHmiSrv --initialize --password=1

# Enable and start HMI Server
echo "[CX] Enabling and starting HMI Server..."
sudo systemctl enable TcHmiSrv.service
sudo systemctl start TcHmiSrv.service

# Install TF1200 UI Client
echo "[CX] Installing TF1200-UI-Client..."
echo "[CX] This will take several minutes - please be patient!"
sudo DEBIAN_FRONTEND=noninteractive apt install -y tf1200-ui-client

# Configure TF1200 UI Client
echo "[CX] Configuring TF1200-UI-Client..."
cd /etc/TwinCAT/Functions/TF1200-UI-Client/scripts
sudo ./setup-full.sh --user=TF1200 --autologin --autostart

# Set password for TF1200 user
echo "[CX] Setting password for TF1200 user..."
echo "TF1200:1" | sudo chpasswd

# Add TF1200 to sudoers
echo "[CX] Adding TF1200 user to sudoers..."
sudo usermod -aG sudo TF1200

# Update package lists
echo "[CX] Upgrading package lists..."
sudo apt upgrade -y

echo "[CX] =========================================="
echo "[CX] Initial setup complete!"
echo "[CX] System will reboot in 5 seconds..."
echo "[CX] =========================================="
sleep 5
sudo reboot
ENDSCRIPT

# Upload and execute the script
log_info "Uploading setup script to CX..."
if ! scp -o StrictHostKeyChecking=no "$TEMP_SCRIPT" Administrator@$CX_IP:/tmp/twincat_setup.sh ; then
    log_error "Failed to upload setup script"
    rm "$TEMP_SCRIPT"
    pause_before_exit 1
fi

log_info "Executing setup script on CX..."
log_warn "This will take 10-15 minutes. Do not interrupt!"
echo ""

if ! ssh -t -t -o StrictHostKeyChecking=no Administrator@$CX_IP "chmod +x /tmp/twincat_setup.sh && /tmp/twincat_setup.sh '$BECKHOFF_USER' '$BECKHOFF_PASS'" ; then
    log_error "Setup script failed on remote system"
    rm "$TEMP_SCRIPT"
    pause_before_exit 1
fi

# Clean up temp file
rm "$TEMP_SCRIPT"

# Wait for reboot
log_info "=========================================="
log_info "Waiting 40 seconds for CX to reboot..."
log_info "=========================================="
sleep 40

# Reconnect and configure TF1200 UI settings
log_info "Reconnecting to configure TF1200 UI Client settings..."


echo ""
log_info "============================================"
log_info "Setup Complete!"
log_info "============================================"
log_info "The CX is rebooting into TF1200-UI-Client."
log_info ""
log_info "Security Notes:"
log_info "  - APT credentials stored in: /etc/apt/auth.conf.d/bhf.conf"
log_info "  - File permissions set to 600 (root read-only)"
log_info "  - Only root user can access credentials"
log_info ""
log_info "Next Steps:"
log_info "  1. Connect a monitor to see TF1200 UI Client boot"
log_info "  2. Add necessary TwinCAT licenses"
log_info "  3. Activate and publish your PLC project to HMI Server"
log_info ""
log_info "Connections available:"
log_info "  ssh Administrator@$CX_IP (password: 1)"
log_info "  ssh TF1200@$CX_IP (password: 1)"
echo ""

pause_before_exit 0
