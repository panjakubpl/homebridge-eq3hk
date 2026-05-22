#!/usr/bin/env bash
# tests/install.test.sh — vanilla-bash test suite for scripts/install.sh
#
# Sources the installer so it can call individual functions in isolation,
# then exercises selected flag and validation paths end-to-end by invoking
# the installer as a child process. No external test framework required;
# run with:
#
#   bash tests/install.test.sh
#
# Exit code is 0 if every assertion passed, 1 otherwise.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$SCRIPT_DIR/../scripts/install.sh"

if [[ ! -f "$INSTALLER" ]]; then
    echo "FATAL: installer not found at $INSTALLER" >&2
    exit 2
fi

# ─── tiny test framework ─────────────────────────────────────────────────────

PASS=0
FAIL=0
FAILED=()
if [[ -t 1 ]]; then
    GREEN="\033[32m"; RED="\033[31m"; DIM="\033[2m"; RESET="\033[0m"
else
    GREEN=""; RED=""; DIM=""; RESET=""
fi

_ok()   { printf "  ${GREEN}✓${RESET} %s\n" "$1"; PASS=$((PASS+1)); }
_fail() { printf "  ${RED}✗${RESET} %s\n" "$1"; FAILED+=("$1"); FAIL=$((FAIL+1)); }

assert_eq() {
    local actual="$1" expected="$2" name="$3"
    if [[ "$actual" == "$expected" ]]; then
        _ok "$name"
    else
        _fail "$name"
        printf "${DIM}      expected: %q\n      actual:   %q${RESET}\n" "$expected" "$actual"
    fi
}

assert_contains() {
    local haystack="$1" needle="$2" name="$3"
    if [[ "$haystack" == *"$needle"* ]]; then
        _ok "$name"
    else
        _fail "$name"
        printf "${DIM}      missing substring: %q${RESET}\n" "$needle"
    fi
}

assert_exit_code() {
    local actual="$1" expected="$2" name="$3"
    if [[ "$actual" == "$expected" ]]; then
        _ok "$name"
    else
        _fail "$name"
        printf "${DIM}      expected exit %s, got %s${RESET}\n" "$expected" "$actual"
    fi
}

section() {
    printf "\n%s\n" "$1"
}

# ─── source installer for function-level tests ───────────────────────────────
# Note: sourcing must NOT trigger main(). The installer guards against this
# with `if [[ "${BASH_SOURCE[0]:-}" == "${0}" ]]; then main "$@"; fi`.

# shellcheck disable=SC1090
source "$INSTALLER"

# ─── parse_args ──────────────────────────────────────────────────────────────

section "parse_args"

DRY_RUN=0; parse_args --dry-run
assert_eq "$DRY_RUN" "1" "--dry-run sets DRY_RUN=1"

MAC=""; parse_args --mac "AA:BB:CC:DD:EE:FF"
assert_eq "$MAC" "AA:BB:CC:DD:EE:FF" "--mac stores MAC value"

SKIP_PAIR=0; parse_args --skip-pair
assert_eq "$SKIP_PAIR" "1" "--skip-pair sets SKIP_PAIR=1"

ASSUME_YES=0; parse_args --yes
assert_eq "$ASSUME_YES" "1" "--yes sets ASSUME_YES=1"

ASSUME_YES=0; parse_args -y
assert_eq "$ASSUME_YES" "1" "-y short form sets ASSUME_YES=1"

DRY_RUN=0; MAC=""; SKIP_PAIR=0
parse_args --dry-run --mac AA:BB:CC:DD:EE:FF --skip-pair
assert_eq "$DRY_RUN" "1" "combined flags: DRY_RUN"
assert_eq "$MAC" "AA:BB:CC:DD:EE:FF" "combined flags: MAC"
assert_eq "$SKIP_PAIR" "1" "combined flags: SKIP_PAIR"

# ─── validate_mac ────────────────────────────────────────────────────────────

section "validate_mac"

validate_mac "AA:BB:CC:DD:EE:FF" && r=0 || r=$?
assert_eq "$r" "0" "valid uppercase MAC returns 0"

validate_mac "aa:bb:cc:dd:ee:ff" && r=0 || r=$?
assert_eq "$r" "0" "valid lowercase MAC returns 0"

validate_mac "1a:2B:3c:4D:5e:6F" && r=0 || r=$?
assert_eq "$r" "0" "valid mixed-case MAC returns 0"

validate_mac "" && r=0 || r=$?
assert_eq "$r" "1" "empty string returns non-zero"

validate_mac "AA:BB:CC:DD:EE" && r=0 || r=$?
assert_eq "$r" "1" "incomplete MAC returns non-zero"

validate_mac "ZZ:BB:CC:DD:EE:FF" && r=0 || r=$?
assert_eq "$r" "1" "MAC with invalid hex chars returns non-zero"

validate_mac "AA-BB-CC-DD-EE-FF" && r=0 || r=$?
assert_eq "$r" "1" "MAC with dashes returns non-zero"

validate_mac "AA:BB:CC:DD:EE:FF; rm -rf /" && r=0 || r=$?
assert_eq "$r" "1" "MAC with shell-injection attempt returns non-zero"

validate_mac "AA:BB:CC:DD:EE:FF " && r=0 || r=$?
assert_eq "$r" "1" "MAC with trailing whitespace returns non-zero"

# ─── usage and --help ────────────────────────────────────────────────────────

section "usage and --help"

usage_output=$(usage)
assert_contains "$usage_output" "Usage:" "usage() contains 'Usage:'"
assert_contains "$usage_output" "homebridge-eq3hk installer" "usage() contains installer name"
assert_contains "$usage_output" "--dry-run" "usage() documents --dry-run"
assert_contains "$usage_output" "--mac" "usage() documents --mac"
assert_contains "$usage_output" "--skip-pair" "usage() documents --skip-pair"
assert_contains "$usage_output" "--help" "usage() documents --help"

# Invoke --help via the script (child process) to exercise exit-0 path
help_out=$(bash "$INSTALLER" --help 2>&1); help_rc=$?
assert_exit_code "$help_rc" "0" "--help exits 0"
assert_contains "$help_out" "Usage:" "--help prints usage"

bash "$INSTALLER" -h >/dev/null 2>&1; help_h_rc=$?
assert_exit_code "$help_h_rc" "0" "-h short form exits 0"

# ─── unknown flag ────────────────────────────────────────────────────────────

section "error handling"

bad_out=$(bash "$INSTALLER" --not-a-real-flag 2>&1); bad_rc=$?
assert_exit_code "$bad_rc" "1" "unknown flag exits 1"
assert_contains "$bad_out" "Unknown option" "unknown flag prints diagnostic"

# ─── dry-run smoke ───────────────────────────────────────────────────────────
# --dry-run with --skip-pair and a fake MAC must complete without modifying
# the system. We assert that no `sudo apt-get install` or `sudo npm install -g`
# were actually invoked by sniffing for the [dry-run] markers.

section "--dry-run smoke (no system changes)"

# Trap interactive prompt by piping empty stdin
# Exit code may be non-zero on non-Linux hosts (macOS dev box) — both paths
# are acceptable here, what matters is that no real install ran.
dry_out=$(bash "$INSTALLER" --dry-run --skip-pair --mac AA:BB:CC:DD:EE:FF </dev/null 2>&1) || true
assert_contains "$dry_out" "dry-run" "dry-run banner present"

# L3 from CR: verify dry-run really doesn't execute anything by asserting
# the absence of the "→ sudo " marker that `run` prints in non-dry mode.
if [[ "$dry_out" == *"→ sudo "* ]]; then
    _fail "dry-run executed a sudo command (saw '→ sudo ' in output)"
else
    _ok "dry-run does NOT contain '→ sudo ' execution markers"
fi

# ─── parser edge cases (regression coverage for CR finding H1) ──────────────

section "parser edge cases (H1 regression)"

mac_then_flag_out=$(bash "$INSTALLER" --mac --dry-run 2>&1); mac_then_flag_rc=$?
assert_exit_code "$mac_then_flag_rc" "1" "--mac --dry-run rejects flag-as-value"
assert_contains "$mac_then_flag_out" "--mac requires a MAC argument" "--mac --dry-run prints diagnostic"

mac_no_value_out=$(bash "$INSTALLER" --mac 2>&1); mac_no_value_rc=$?
assert_exit_code "$mac_no_value_rc" "1" "--mac at end of argv rejected"
assert_contains "$mac_no_value_out" "--mac requires a MAC argument" "--mac at end prints diagnostic"

bash "$INSTALLER" --mac "" --dry-run >/dev/null 2>&1; mac_empty_rc=$?
assert_exit_code "$mac_empty_rc" "1" "--mac with empty value rejected"

# ─── render_systemd_unit smoke (M2 refactor coverage) ───────────────────────

section "render_systemd_unit (pure-function refactor)"

unit_body=$(render_systemd_unit "/usr/lib/node_modules/homebridge-eq3hk/mqtt_handler.js" \
                                "/usr/lib/node_modules/homebridge-eq3hk" \
                                "/usr/bin/node" \
                                "pi")
assert_contains "$unit_body" "[Unit]" "unit body has [Unit] section"
assert_contains "$unit_body" "[Service]" "unit body has [Service] section"
assert_contains "$unit_body" "[Install]" "unit body has [Install] section"
assert_contains "$unit_body" "ExecStart=/usr/bin/node /usr/lib/node_modules/homebridge-eq3hk/mqtt_handler.js" "ExecStart line correctly composed"
assert_contains "$unit_body" "User=pi" "User= correctly populated"
assert_contains "$unit_body" "Restart=on-failure" "Restart= set"
assert_contains "$unit_body" "WantedBy=multi-user.target" "WantedBy= set"

# ─── final report ────────────────────────────────────────────────────────────

printf "\n─────────────────────────────────────────\n"
TOTAL=$((PASS + FAIL))
if [[ $FAIL -eq 0 ]]; then
    printf "%sAll %d tests passed%s\n" "$GREEN" "$TOTAL" "$RESET"
    exit 0
else
    printf "%s%d failed%s, %s%d passed%s (%d total)\n" "$RED" "$FAIL" "$RESET" "$GREEN" "$PASS" "$RESET" "$TOTAL"
    printf "%sFailed assertions:%s\n" "$RED" "$RESET"
    # L5 from CR: guard against empty FAILED[@] expansion under set -u on bash 3.2.
    for f in "${FAILED[@]+"${FAILED[@]}"}"; do printf "  - %s\n" "$f"; done
    exit 1
fi
