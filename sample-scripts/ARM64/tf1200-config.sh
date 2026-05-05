#!/usr/bin/env bash
#
# TF1200 Configuration Script
# Updates TF1200-UI-Client config to point to HMI Server and enables kiosk mode
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
    local default_value="$4"
    
    if [ "$is_password" = "true" ]; then
        read -s -p "$prompt_msg" $var_name
        echo
    else
        if [ -n "$default_value" ]; then
            read -p "$prompt_msg" -e -i "$default_value" $var_name
        else
            read -p "$prompt_msg" $var_name
        fi
    fi
}

# Main script starts here
echo "========================================"
echo "  TF1200-UI-Client Configuration"
echo "========================================"
echo

# Prompt for CX IP address
prompt_input "Enter the IP address of the CX: " CX_IP false

if [ -z "$CX_IP" ]; then
    log_error "IP address cannot be empty!"
    pause_before_exit 1
fi

# Prompt for HMI Server URL
echo
log_info "Enter the HMI Server URL:"
log_info "  Examples:"
log_info "    - Self-hosted: https://$CX_IP:2020"
log_info "    - Remote server: https://192.168.1.100:2020"
echo
prompt_input "HMI Server URL: " HMI_URL false "https://$CX_IP:"

if [ -z "$HMI_URL" ]; then
    log_error "HMI Server URL cannot be empty!"
    pause_before_exit 1
fi

# Confirm inputs
echo
echo "Configuration Summary:"
echo "  CX IP Address: $CX_IP"
echo "  HMI Server URL: $HMI_URL"
echo
read -p "Continue with these settings? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    log_error "Configuration cancelled by user."
    pause_before_exit 0
fi

log_info "Connecting to CX at $CX_IP..."
log_warn "You will be prompted for Administrator password"
echo ""

# Test SSH connection
log_info "Testing SSH connection..."
if ! ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 Administrator@$CX_IP "echo 'Connection test successful'" ; then
    log_error "Failed to connect to $CX_IP"
    log_error "Please check:"
    log_error "  1. IP address is correct"
    log_error "  2. CX is powered on and network connected"
    log_error "  3. You entered the correct password"
    pause_before_exit 1
fi

log_info "SSH connection successful! Starting configuration..."
echo ""

# Create the configuration script
TEMP_SCRIPT=$(mktemp)
cat > "$TEMP_SCRIPT" <<'ENDSCRIPT'
#!/bin/bash
set -e

echo "[CX] =========================================="
echo "[CX] Configuring TF1200-UI-Client"
echo "[CX] =========================================="
echo ""

# Get arguments
HMI_URL="$1"

CONFIG_FILE="/home/TF1200/.config/TF1200-UI-Client/config.json"

# Check if TF1200 user exists
if ! id "TF1200" &>/dev/null; then
    echo "[CX] ERROR: TF1200 user does not exist!"
    echo "[CX] Please run the main setup script first."
    exit 1
fi

# Check if config file exists (using sudo)
if ! sudo test -f "$CONFIG_FILE"; then
    echo "[CX] ERROR: Config file not found at $CONFIG_FILE"
    echo "[CX] Checking directory contents..."
    sudo ls -la /home/TF1200/.config/TF1200-UI-Client/ || true
    echo "[CX] Please ensure TF1200-UI-Client is properly configured."
    exit 1
fi

echo "[CX] Config file found at $CONFIG_FILE"

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo "[CX] Installing jq for JSON manipulation..."
    sudo DEBIAN_FRONTEND=noninteractive apt update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt install -y jq
fi

echo "[CX] Current configuration:"
sudo jq -r '.startUrl' "$CONFIG_FILE" | xargs -I {} echo "[CX]   startUrl: {}"
sudo jq -r '.enableKioskMode' "$CONFIG_FILE" | xargs -I {} echo "[CX]   enableKioskMode: {}"
echo ""

echo "[CX] Updating TF1200 UI Client settings..."
echo "[CX]   New HMI Server URL: $HMI_URL"

# Create backup
BACKUP_FILE="${CONFIG_FILE}.backup.$(date +%Y%m%d_%H%M%S)"
sudo cp "$CONFIG_FILE" "$BACKUP_FILE"
echo "[CX] Backup created: $BACKUP_FILE"

# Update the config file using jq
sudo jq --arg url "$HMI_URL" \
    '.startUrl = $url | 
     .enableKioskMode = true | 
     .commandLineSwitches = ["ignore-certificate-errors"]' \
    "$CONFIG_FILE" > /tmp/config.json.tmp

# Replace the original file
sudo mv /tmp/config.json.tmp "$CONFIG_FILE"

# Set proper ownership and permissions
sudo chown TF1200:TF1200 "$CONFIG_FILE"
sudo chmod 644 "$CONFIG_FILE"

echo "[CX] Configuration updated successfully!"
echo ""
echo "[CX] New configuration:"
sudo jq -r '.startUrl' "$CONFIG_FILE" | xargs -I {} echo "[CX]   startUrl: {}"
sudo jq -r '.enableKioskMode' "$CONFIG_FILE" | xargs -I {} echo "[CX]   enableKioskMode: {}"
sudo jq -r '.commandLineSwitches[]' "$CONFIG_FILE" | xargs -I {} echo "[CX]   commandLineSwitches: {}"
echo ""
echo "[CX] =========================================="
echo "[CX] Configuration complete!"
echo "[CX] System will reboot in 5 seconds..."
echo "[CX] =========================================="
sleep 5
sudo reboot
ENDSCRIPT

# Upload the script
log_info "Uploading configuration script to CX..."
if ! scp -o StrictHostKeyChecking=no "$TEMP_SCRIPT" Administrator@$CX_IP:/tmp/tf1200_configure.sh ; then
    log_error "Failed to upload configuration script"
    rm "$TEMP_SCRIPT"
    pause_before_exit 1
fi

log_info "Executing configuration script on CX..."
log_warn "You will be prompted for Administrator password again"
echo ""

# Execute the configuration script
if ! ssh -t -t -o StrictHostKeyChecking=no Administrator@$CX_IP "chmod +x /tmp/tf1200_configure.sh && /tmp/tf1200_configure.sh '$HMI_URL'" ; then
    log_error "Configuration script failed on remote system"
    rm "$TEMP_SCRIPT"
    pause_before_exit 1
fi

# Clean up temp file
rm "$TEMP_SCRIPT"

echo ""
log_info "============================================"
log_info "TF1200 Configuration Complete!"
log_info "============================================"
log_info "The CX is now rebooting..."
log_info ""
log_info "Configuration Applied:"
log_info "  ✓ HMI Server URL: $HMI_URL"
log_info "  ✓ Kiosk Mode: Enabled"
log_info "  ✓ Certificate Errors: Ignored"
log_info "  ✓ Backup created with timestamp"
log_info ""
log_info "Next Steps:"
log_info "  1. Wait for CX to finish rebooting (~30 seconds)"
log_info "  2. Connect a monitor to see TF1200 UI Client"
log_info "  3. The UI should automatically load your HMI"
log_info ""
log_info "Troubleshooting:"
log_info "  - If HMI doesn't load, check that TF2000 HMI Server is running"
log_info "  - Verify HMI project is published to the server"
log_info "  - Check config: ssh TF1200@$CX_IP 'cat ~/.config/TF1200-UI-Client/config.json'"
log_info "  - View backups: ssh Administrator@$CX_IP"
log_info "    'sudo ls -la /home/TF1200/.config/TF1200-UI-Client/*.backup*'"
log_info ""
log_info "SSH Access:"
log_info "  ssh Administrator@$CX_IP"
log_info "  ssh TF1200@$CX_IP (password: 1)"
echo ""

pause_before_exit 0
