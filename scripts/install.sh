#!/usr/bin/env bash
#
# homebridge-eq3hk installer — one-shot setup for Raspberry Pi / Debian hosts.
#
# Walks the host through every prerequisite that the README's manual flow
# spells out across six numbered steps, and finishes with a copy-pasteable
# Homebridge UI snippet. Re-running is safe: every step detects existing
# state and skips when nothing to do.
#
# Usage:
#   bash scripts/install.sh [--mac MAC] [--dry-run] [--skip-pair] [-y] [-h]
#
# This file is also sourced by tests/install.test.sh, so the actual install
# only runs when the script is executed directly (BASH_SOURCE guard at the
# bottom).

set -uo pipefail

# ─── defaults ────────────────────────────────────────────────────────────────

DRY_RUN=0
MAC=""
SKIP_PAIR=0
ASSUME_YES=0

PLUGIN_NAME="homebridge-eq3hk"
SYSTEMD_UNIT_PATH="/etc/systemd/system/mqtt_handler.service"
SERVICE_USER="${SUDO_USER:-${USER:-pi}}"

# ─── colors (NO_COLOR aware, no-tty aware) ───────────────────────────────────

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
    BOLD=$'\e[1m'
    DIM=$'\e[2m'
    RED=$'\e[31m'
    GREEN=$'\e[32m'
    YELLOW=$'\e[33m'
    BLUE=$'\e[34m'
    CYAN=$'\e[36m'
    RESET=$'\e[0m'
else
    BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; CYAN=""; RESET=""
fi

# ─── logging helpers ─────────────────────────────────────────────────────────

log_step() { printf "\n%s━━ %s%s\n" "$CYAN$BOLD" "$1" "$RESET"; }
log_ok()   { printf "  %s✓%s %s\n" "$GREEN" "$RESET" "$1"; }
log_warn() { printf "  %s!%s %s\n" "$YELLOW" "$RESET" "$1"; }
log_err()  { printf "  %s✗%s %s\n" "$RED" "$RESET" "$1" >&2; }
log_info() { printf "    %s%s%s\n" "$DIM" "$1" "$RESET"; }
log_dry()  { printf "    %s[dry-run]%s %s\n" "$YELLOW" "$RESET" "$1"; }

# ─── usage ───────────────────────────────────────────────────────────────────

usage() {
    cat <<EOF
${BOLD}homebridge-eq3hk installer${RESET}

Walks your Raspberry Pi / Debian host through every step needed to run the
Eqiva eQ-3 Bluetooth thermostat plugin: apt packages, the npm plugin install,
the bluetoothctl pair flow, and the systemd unit for the MQTT helper. Idempotent
— safe to run twice.

${BOLD}Usage:${RESET}
  bash $(basename "$0") [options]

${BOLD}Options:${RESET}
  --mac MAC         Thermostat MAC address (skips the interactive prompt)
  --dry-run         Show every action that would run, change nothing
  --skip-pair       Skip the Bluetooth pair step (use when already bonded)
  --yes, -y         Assume "yes" for all confirmations
  --help, -h        Show this help and exit

${BOLD}The installer will:${RESET}
  1. Verify the host (Linux + apt + systemd)
  2. Install missing packages: expect, mosquitto, mosquitto-clients, bluez
  3. Install the ${PLUGIN_NAME} plugin globally via npm
  4. Pair the thermostat (delegates to scripts/pair.sh)
  5. Install + enable the mqtt_handler systemd service
  6. Print the Homebridge UI accessory snippet to paste

${BOLD}Examples:${RESET}
  bash $(basename "$0") --dry-run                    # preview, no changes
  bash $(basename "$0") --mac AA:BB:CC:DD:EE:FF      # non-interactive MAC
  bash $(basename "$0") --skip-pair --mac …          # already paired
EOF
}

# ─── arg parsing ─────────────────────────────────────────────────────────────

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --mac)
                # Reject missing value or `--mac --other-flag` (which would
                # otherwise silently swallow the next flag as MAC value and
                # leave the rest of parsing in an inconsistent state).
                if [[ $# -lt 2 || -z "${2:-}" || "${2:0:2}" == "--" ]]; then
                    log_err "--mac requires a MAC argument (e.g. --mac AA:BB:CC:DD:EE:FF)"
                    exit 1
                fi
                MAC="$2"; shift 2 ;;
            --dry-run)    DRY_RUN=1;       shift ;;
            --skip-pair)  SKIP_PAIR=1;     shift ;;
            --yes|-y)     ASSUME_YES=1;    shift ;;
            --help|-h)    usage;           exit 0 ;;
            *)
                log_err "Unknown option: $1"
                printf "\nRun with --help for usage.\n" >&2
                exit 1
                ;;
        esac
    done
}

# ─── tiny helpers ────────────────────────────────────────────────────────────

# Run a command; in dry-run mode print it but do nothing. Returns the
# command's exit code (always 0 in dry-run).
run() {
    if [[ $DRY_RUN -eq 1 ]]; then
        log_dry "$*"
        return 0
    fi
    log_info "→ $*"
    "$@"
}

# Strict MAC validator. Refuses anything other than six colon-separated
# hex pairs — guards every place where the MAC is later passed to a shell.
validate_mac() {
    [[ "${1:-}" =~ ^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$ ]]
}

is_package_installed() {
    dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q "install ok installed"
}

confirm() {
    local prompt="$1"
    if [[ $ASSUME_YES -eq 1 ]]; then
        log_info "[--yes] $prompt → assuming yes"
        return 0
    fi
    printf "  %s? [y/N] " "$prompt"
    local reply
    read -r reply
    [[ "$reply" =~ ^[Yy] ]]
}

# Resolve the installed plugin's directory. The plugin can live in two
# common places: the global npm prefix, or the Homebridge UI's local prefix
# at /var/lib/homebridge/node_modules. Return the first that exists.
resolve_plugin_dir() {
    local candidates=(
        "/usr/lib/node_modules/$PLUGIN_NAME"
        "/usr/local/lib/node_modules/$PLUGIN_NAME"
        "/var/lib/homebridge/node_modules/$PLUGIN_NAME"
    )
    for d in "${candidates[@]}"; do
        if [[ -d "$d" ]]; then
            printf "%s" "$d"
            return 0
        fi
    done
    return 1
}

# ─── step implementations ────────────────────────────────────────────────────

check_host() {
    log_step "1/6  Host check"
    if [[ "$(uname -s)" != "Linux" ]]; then
        log_err "This installer is Linux-only (detected: $(uname -s))."
        log_info "If you really want to develop on macOS, use --dry-run to lint the flow."
        [[ $DRY_RUN -eq 1 ]] || exit 1
    else
        log_ok "Linux detected"
    fi
    if command -v apt-get >/dev/null 2>&1; then
        log_ok "apt-get available"
    else
        log_err "apt-get not found — installer assumes Debian/Ubuntu/Raspberry Pi OS."
        [[ $DRY_RUN -eq 1 ]] || exit 1
    fi
    if command -v systemctl >/dev/null 2>&1; then
        log_ok "systemd available"
    else
        log_err "systemctl not found — installer requires systemd."
        [[ $DRY_RUN -eq 1 ]] || exit 1
    fi
}

install_packages() {
    log_step "2/6  System packages"
    local needed=()
    local pkg
    for pkg in expect mosquitto mosquitto-clients bluez; do
        if is_package_installed "$pkg"; then
            log_ok "$pkg already installed"
        else
            needed+=("$pkg")
        fi
    done
    if [[ ${#needed[@]} -eq 0 ]]; then
        log_info "Nothing to install."
        return
    fi
    log_info "Will install: ${needed[*]}"
    run sudo apt-get update -qq || { log_err "apt-get update failed — fix the source list / network and re-run."; exit 1; }
    run sudo apt-get install -y "${needed[@]}" || { log_err "apt-get install failed — aborting."; exit 1; }

    # mosquitto needs to be enabled+started for plugin polling to work.
    # Guard against the package not being installed (apt failure earlier in
    # this function with -e off) by checking the unit file exists first.
    if systemctl list-unit-files mosquitto.service >/dev/null 2>&1; then
        if ! systemctl is-enabled --quiet mosquitto 2>/dev/null; then
            run sudo systemctl enable mosquitto
        fi
        if ! systemctl is-active --quiet mosquitto 2>/dev/null; then
            run sudo systemctl start mosquitto
        fi
        log_ok "mosquitto running"
    else
        log_warn "mosquitto.service unit not registered — skipping enable/start."
    fi
}

install_plugin() {
    log_step "3/6  Plugin install"
    if resolve_plugin_dir >/dev/null; then
        local dir
        dir=$(resolve_plugin_dir)
        local installed_version
        installed_version=$(node -p "require('$dir/package.json').version" 2>/dev/null || echo "?")
        log_ok "$PLUGIN_NAME@$installed_version already present at $dir"
        log_info "(to upgrade: sudo npm install -g $PLUGIN_NAME@latest)"
        return
    fi
    if ! command -v npm >/dev/null 2>&1; then
        log_err "npm not found — install Node.js + npm first (see Homebridge install docs)."
        [[ $DRY_RUN -eq 1 ]] || exit 1
    fi
    run sudo npm install -g "$PLUGIN_NAME"
}

prompt_mac() {
    log_step "4/6  Thermostat pairing"
    if [[ $SKIP_PAIR -eq 1 ]]; then
        log_warn "Pairing skipped (--skip-pair). Make sure 'bluetoothctl info <MAC>'"
        log_info "shows Paired: yes / Bonded: yes / Trusted: yes."
        return
    fi
    if [[ -n "$MAC" ]]; then
        if ! validate_mac "$MAC"; then
            log_err "Invalid MAC from --mac: $MAC"
            exit 1
        fi
        log_ok "Using MAC: $MAC"
        return
    fi
    if [[ $ASSUME_YES -eq 1 ]]; then
        log_warn "--yes WITHOUT --mac: thermostat will NOT be paired."
        log_warn "You MUST run 'sudo scripts/pair.sh <MAC>' before the plugin will work."
        log_info "(or re-run this installer with --mac <MAC> once you have it)"
        SKIP_PAIR=1
        return
    fi
    printf "\n  Enter your thermostat's MAC address (format %sXX:XX:XX:XX:XX:XX%s): " "$BOLD" "$RESET"
    read -r MAC
    if ! validate_mac "$MAC"; then
        log_err "Invalid MAC format: ${MAC:-<empty>}"
        exit 1
    fi
}

pair_thermostat() {
    if [[ $SKIP_PAIR -eq 1 ]]; then
        return
    fi
    local plugin_dir pair_script
    if ! plugin_dir=$(resolve_plugin_dir); then
        log_err "Cannot find the installed plugin directory."
        log_info "Was the npm install step skipped or failed?"
        [[ $DRY_RUN -eq 1 ]] || exit 1
        return
    fi
    pair_script="$plugin_dir/scripts/pair.sh"
    if [[ ! -x "$pair_script" ]]; then
        log_err "pair.sh missing or not executable at $pair_script"
        [[ $DRY_RUN -eq 1 ]] || exit 1
        return
    fi
    log_info "Delegating to $pair_script"
    log_info "(you'll be asked to long-press the thermostat wheel and enter the PIN)"
    run sudo "$pair_script" "$MAC"
}

# Render the systemd unit body to stdout. Pure function (no side effects) —
# kept separate so --dry-run can preview it and so unit tests can assert on it.
render_systemd_unit() {
    local handler="$1" working_dir="$2" node_bin="$3" service_user="$4"
    cat <<EOF
[Unit]
Description=homebridge-eq3hk MQTT handler (Bluetooth bridge for eQ-3 thermostats)
After=network-online.target mosquitto.service bluetooth.service
Wants=network-online.target mosquitto.service bluetooth.service

[Service]
Type=simple
ExecStart=$node_bin $handler
WorkingDirectory=$working_dir
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
User=$service_user

[Install]
WantedBy=multi-user.target
EOF
}

install_systemd_unit() {
    log_step "5/6  mqtt_handler systemd service"

    local plugin_dir handler working_dir node_bin expected_exec
    if ! plugin_dir=$(resolve_plugin_dir); then
        if [[ $DRY_RUN -eq 1 ]]; then
            log_dry "Would write $SYSTEMD_UNIT_PATH (plugin not yet installed on this host — placeholder paths used in preview)"
            log_dry "Would: sudo systemctl daemon-reload; sudo systemctl enable mqtt_handler; sudo systemctl start mqtt_handler"
            return
        fi
        log_err "Cannot locate plugin to determine mqtt_handler.js path."
        exit 1
    fi
    handler="$plugin_dir/mqtt_handler.js"
    working_dir="$plugin_dir"
    node_bin=$(command -v node || printf "/usr/bin/node")
    expected_exec="ExecStart=$node_bin $handler"

    # M1: refuse silently running as root (common gotcha with `sudo -i` flow).
    if [[ "$SERVICE_USER" == "root" ]]; then
        log_warn "Service would run as root (SUDO_USER/USER both root)."
        log_warn "This is unusual for a BLE+MQTT daemon — usually you want User=pi."
        if ! confirm "Proceed anyway and write User=root in the unit"; then
            log_err "Aborting. Re-run from a non-root shell, e.g. 'sudo bash $(basename "$0")'."
            exit 1
        fi
    else
        log_info "Service will run as user: $SERVICE_USER"
    fi

    # H2: detect a stale unit that points at a different binary/path and
    # rewrite it. The previous "skip if exists" behaviour silently kept
    # broken units alive across upgrades or path moves.
    if [[ -f "$SYSTEMD_UNIT_PATH" ]]; then
        if grep -qxF "$expected_exec" "$SYSTEMD_UNIT_PATH"; then
            log_ok "Unit already exists and points at $handler"
            if systemctl is-active --quiet mqtt_handler 2>/dev/null; then
                log_ok "Service is active"
            else
                log_warn "Service exists but is not active — restarting"
                run sudo systemctl restart mqtt_handler || {
                    log_err "Restart failed — see 'journalctl -u mqtt_handler' for details."
                    exit 1
                }
            fi
            return
        fi
        log_warn "Existing unit at $SYSTEMD_UNIT_PATH points elsewhere — rewriting"
        log_info "(old ExecStart will be replaced with: $expected_exec)"
    fi

    # M2: factored render → dry-run preview shows full unit body.
    local unit_body
    unit_body=$(render_systemd_unit "$handler" "$working_dir" "$node_bin" "$SERVICE_USER")

    if [[ $DRY_RUN -eq 1 ]]; then
        log_dry "Would write $SYSTEMD_UNIT_PATH with body:"
        while IFS= read -r unit_line; do
            printf "    %s│%s %s\n" "$DIM" "$RESET" "$unit_line"
        done <<< "$unit_body"
        log_dry "Would: sudo systemctl daemon-reload; sudo systemctl enable mqtt_handler; sudo systemctl start mqtt_handler"
        return
    fi

    local tmp_unit
    tmp_unit=$(mktemp)
    printf "%s\n" "$unit_body" > "$tmp_unit"

    # H3: halt on any failure in the cascade. Previously a failure here
    # would still leave print_summary saying "Setup complete." on a broken
    # host.
    if ! run sudo install -m 0644 "$tmp_unit" "$SYSTEMD_UNIT_PATH"; then
        rm -f "$tmp_unit"
        log_err "Failed to write unit file at $SYSTEMD_UNIT_PATH — aborting."
        exit 1
    fi
    rm -f "$tmp_unit"
    run sudo systemctl daemon-reload || { log_err "daemon-reload failed — aborting."; exit 1; }
    run sudo systemctl enable mqtt_handler || { log_err "systemctl enable mqtt_handler failed — aborting."; exit 1; }
    run sudo systemctl start mqtt_handler || {
        log_err "systemctl start mqtt_handler failed — see 'journalctl -u mqtt_handler' for details."
        exit 1
    }
    log_ok "mqtt_handler service installed and started"
}

print_summary() {
    log_step "6/6  Final step — add the accessory in Homebridge UI"

    local effective_mac="${MAC:-XX:XX:XX:XX:XX:XX}"
    if [[ -z "$MAC" ]]; then
        log_warn "No MAC supplied — REPLACE 'XX:XX:XX:XX:XX:XX' in the snippet below"
        log_warn "with your thermostat's real MAC before saving the config."
    fi
    cat <<EOF

  Open the Homebridge UI in your browser and add a new accessory of type
  ${BOLD}EQ3Thermostat${RESET}. Paste this snippet (or use the visual form) as a
  starting point, then save and restart Homebridge:

${CYAN}    {
      "accessory": "EQ3Thermostat",
      "name": "Living Room Thermostat",
      "macAddress": "$effective_mac",
      "mqttUrl": "mqtt://localhost",
      "cacheDuration": 10
    }${RESET}

  ${BOLD}Multiple thermostats?${RESET} Repeat with a different MAC and name.

  ${BOLD}Verify everything works:${RESET}
      sudo journalctl -u mqtt_handler -f
  Within ~10 seconds you should see lines like:
      Current temperature for MAC address $effective_mac: 21.5°C

  ${GREEN}${BOLD}✓ Setup complete.${RESET}

EOF
}

# ─── main ────────────────────────────────────────────────────────────────────

main() {
    parse_args "$@"

    printf "\n%s┌─────────────────────────────────────────────────────────┐%s\n" "$BOLD$BLUE" "$RESET"
    printf "%s│  homebridge-eq3hk installer                             │%s\n" "$BOLD$BLUE" "$RESET"
    printf "%s│  Eqiva eQ-3 Bluetooth thermostat plugin for Homebridge  │%s\n" "$BOLD$BLUE" "$RESET"
    printf "%s└─────────────────────────────────────────────────────────┘%s\n" "$BOLD$BLUE" "$RESET"
    if [[ $DRY_RUN -eq 1 ]]; then
        printf "%s  Running in --dry-run mode — no changes will be made.%s\n" "$YELLOW$BOLD" "$RESET"
    fi

    check_host
    install_packages
    install_plugin
    prompt_mac
    pair_thermostat
    install_systemd_unit
    print_summary
}

# Only run main when executed directly. When sourced (e.g. from the test
# suite) the functions are exposed but no side effects occur.
if [[ "${BASH_SOURCE[0]:-$0}" == "${0}" ]]; then
    main "$@"
fi
