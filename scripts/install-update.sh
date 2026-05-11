#!/bin/bash
# ============================================================================
# Onereach.ai self-install helper
# ============================================================================
# Spawned detached by main.js's _spawnInstallHelper after the app calls
# performUpdateInstall. We bypass Squirrel.Mac because its bundle-swap path
# is broken on macOS 26.4 (uses deprecated `launchctl submit` API; the
# entry shows up in `launchctl list` but launchd never schedules the job).
#
# Required env vars:
#   ONEREACH_PARENT_PID      - PID of the Electron process to wait for
#   ONEREACH_TARGET_VERSION  - Version string we're installing (for status file)
#   ONEREACH_APP_PATH        - Target /Applications path (e.g. /Applications/Onereach.ai.app)
#   ONEREACH_SHIPIT_CACHE    - Path to ~/Library/Caches/<appId>.ShipIt
#   ONEREACH_UPDATER_CACHE   - Path to ~/Library/Caches/<appName>-updater/pending
#   ONEREACH_LOG             - Where to write progress log
#   ONEREACH_STATUS_FILE     - Where to write last-install-result.json
#
# Status file format (JSON):
#   { "version": "X.Y.Z",
#     "outcome": "success" | "failed",
#     "step": "starting|wait_parent|find_bundle|verify_codesign|swap|launch|done",
#     "errorMessage": "..."   (only when outcome=failed),
#     "time": "ISO 8601" }
# ============================================================================

# We deliberately do NOT `set -e` because we want to control the failure path
# explicitly so we can write the status file before exiting.
set -uo pipefail

# Detached children inherit a stripped PATH from launchd; restore the
# system path so codesign / ditto / xattr / open / mv / mktemp resolve.
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

# ---------------------------------------------------------------------------
# Args / env validation
# ---------------------------------------------------------------------------
PARENT_PID="${ONEREACH_PARENT_PID:-}"
TARGET_VERSION="${ONEREACH_TARGET_VERSION:-unknown}"
APP_PATH="${ONEREACH_APP_PATH:-}"
SHIPIT_CACHE="${ONEREACH_SHIPIT_CACHE:-}"
UPDATER_CACHE="${ONEREACH_UPDATER_CACHE:-}"
LOG="${ONEREACH_LOG:-/tmp/onereach-installer-fallback.log}"
STATUS_FILE="${ONEREACH_STATUS_FILE:-}"

# All output goes to LOG. Tests can read it; main.js can show it on failure.
exec >> "$LOG" 2>&1

ts() { date '+%H:%M:%S'; }
iso() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# ---------------------------------------------------------------------------
# Status file writer. Called on every exit path so main.js's boot-time
# verifier always has something to read (even on cataclysmic failure --
# trap below covers the unexpected-exit case).
# ---------------------------------------------------------------------------
write_status() {
    local outcome="$1"
    local step="$2"
    local error_message="${3:-}"
    if [ -z "$STATUS_FILE" ]; then return 0; fi

    # Escape backslashes and quotes in error message for JSON.
    local escaped_msg
    escaped_msg=$(printf '%s' "$error_message" | sed 's/\\/\\\\/g; s/"/\\"/g')

    local status_dir
    status_dir=$(dirname "$STATUS_FILE")
    mkdir -p "$status_dir" 2>/dev/null || true

    cat > "$STATUS_FILE" <<EOF
{
  "version": "$TARGET_VERSION",
  "outcome": "$outcome",
  "step": "$step",
  "errorMessage": "$escaped_msg",
  "time": "$(iso)"
}
EOF
}

# Trap to catch unexpected exits. write_status default = failed/unknown.
EXPECTED_EXIT=0
trap 'if [ "$EXPECTED_EXIT" = "0" ]; then write_status failed unknown "helper exited unexpectedly"; fi' EXIT

# ---------------------------------------------------------------------------
# Pre-flight env validation
# ---------------------------------------------------------------------------
if [ -z "$PARENT_PID" ] || [ -z "$APP_PATH" ] || [ -z "$SHIPIT_CACHE" ]; then
    echo "[$(ts)] FATAL: missing required env vars"
    echo "  PARENT_PID=$PARENT_PID"
    echo "  APP_PATH=$APP_PATH"
    echo "  SHIPIT_CACHE=$SHIPIT_CACHE"
    write_status failed starting "missing required env vars"
    EXPECTED_EXIT=1
    exit 1
fi

echo "[$(ts)] onereach-installer starting"
echo "  parent PID:    $PARENT_PID"
echo "  target ver:    $TARGET_VERSION"
echo "  app path:      $APP_PATH"
echo "  ShipIt cache:  $SHIPIT_CACHE"
echo "  updater cache: $UPDATER_CACHE"

# Derive the bundle filename from APP_PATH so the same script serves
# both the full app ("Onereach.ai.app") and Lite ("Onereach.ai Lite.app")
# without a separate env var. Squirrel.Mac unpacks the staged bundle
# under the same filename as the installed one, so this matches both
# the Squirrel-cache and updater-cache extraction paths.
BUNDLE_NAME="$(basename "$APP_PATH")"
echo "  bundle name:   $BUNDLE_NAME"

# ---------------------------------------------------------------------------
# 1. Wait for parent (Electron process) to fully exit. Up to 30s.
# ---------------------------------------------------------------------------
write_status pending wait_parent ""
echo "[$(ts)] waiting for parent PID $PARENT_PID to exit..."
for i in $(seq 1 30); do
    if ! kill -0 "$PARENT_PID" 2>/dev/null; then
        echo "[$(ts)] parent exited after ${i}s"
        break
    fi
    sleep 1
done
if kill -0 "$PARENT_PID" 2>/dev/null; then
    echo "[$(ts)] WARNING: parent still alive after 30s, force-killing"
    kill -9 "$PARENT_PID" 2>/dev/null || true
    sleep 1
fi

# ---------------------------------------------------------------------------
# 2. Locate the new .app bundle. Try Squirrel's already-unpacked cache
# first (fastest path); fall back to extracting the electron-updater ZIP.
# ---------------------------------------------------------------------------
write_status pending find_bundle ""
NEW_APP=""
for d in "$SHIPIT_CACHE"/update.*; do
    if [ -d "$d/$BUNDLE_NAME" ]; then
        NEW_APP="$d/$BUNDLE_NAME"
        break
    fi
done

if [ -z "$NEW_APP" ]; then
    echo "[$(ts)] no Squirrel cache, extracting from electron-updater ZIP"
    if [ -z "$UPDATER_CACHE" ]; then
        write_status failed find_bundle "no Squirrel cache and no UPDATER_CACHE provided"
        EXPECTED_EXIT=1
        exit 1
    fi
    ZIP=$(ls "$UPDATER_CACHE"/*.zip 2>/dev/null | head -1)
    if [ -z "$ZIP" ]; then
        echo "[$(ts)] FATAL: no update bundle found in either cache"
        write_status failed find_bundle "no update bundle found in Squirrel cache or updater cache"
        EXPECTED_EXIT=1
        exit 1
    fi
    EXTRACT_DIR=$(mktemp -d)
    echo "[$(ts)] extracting $ZIP -> $EXTRACT_DIR"
    if ! ditto -x -k "$ZIP" "$EXTRACT_DIR"; then
        write_status failed find_bundle "ditto -x failed extracting ZIP"
        EXPECTED_EXIT=1
        exit 1
    fi
    NEW_APP="$EXTRACT_DIR/$BUNDLE_NAME"
fi

if [ ! -d "$NEW_APP" ]; then
    echo "[$(ts)] FATAL: NEW_APP path doesn't exist: $NEW_APP"
    write_status failed find_bundle "resolved bundle path does not exist: $NEW_APP"
    EXPECTED_EXIT=1
    exit 1
fi
echo "[$(ts)] new bundle: $NEW_APP"

# ---------------------------------------------------------------------------
# 3. Verify the new bundle's signature before swapping. If this fails,
# refuse to install -- bad bundle is worse than a stale bundle.
# ---------------------------------------------------------------------------
write_status pending verify_codesign ""
if ! codesign --verify "$NEW_APP" 2>/dev/null; then
    echo "[$(ts)] FATAL: codesign --verify failed on new bundle"
    write_status failed verify_codesign "codesign --verify failed on new bundle"
    EXPECTED_EXIT=1
    exit 1
fi
echo "[$(ts)] codesign verify ok"

# ---------------------------------------------------------------------------
# 4. Swap. Move the old aside (rollback safety), ditto the new in.
# ---------------------------------------------------------------------------
write_status pending swap ""
BACKUP="$APP_PATH.old.$(date +%s)"
echo "[$(ts)] backing up old: $APP_PATH -> $BACKUP"
if ! mv "$APP_PATH" "$BACKUP"; then
    echo "[$(ts)] FATAL: failed to rename old bundle (permissions?)"
    write_status failed swap "failed to rename old bundle to backup (permissions?)"
    EXPECTED_EXIT=1
    exit 1
fi

echo "[$(ts)] ditto new bundle into $APP_PATH"
if ! ditto "$NEW_APP" "$APP_PATH"; then
    echo "[$(ts)] FATAL: ditto failed, rolling back"
    rm -rf "$APP_PATH" 2>/dev/null || true
    mv "$BACKUP" "$APP_PATH" 2>/dev/null || true
    write_status failed swap "ditto into /Applications failed, rolled back to previous version"
    EXPECTED_EXIT=1
    exit 1
fi

# Strip quarantine just in case (newly-built bundles don't get tagged,
# but it's cheap insurance).
xattr -d com.apple.quarantine "$APP_PATH" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 5. Launch the new version. The status file is written as `success` BEFORE
# the launch so that even if `open` somehow fails to start the new app,
# our boot-time verifier (when the user manually re-launches later) can
# still tell that the swap itself completed.
# ---------------------------------------------------------------------------
write_status success launch ""
echo "[$(ts)] swap complete, launching new version"
if ! open "$APP_PATH"; then
    # `open` failure here is rare but possible if launchd is sick.
    # We've already overwritten the bundle so we can't roll back, but the
    # status file already says success and the new bundle IS in place --
    # next launch from /Applications will work.
    echo "[$(ts)] WARNING: 'open $APP_PATH' returned non-zero"
fi

# ---------------------------------------------------------------------------
# 6. Done. Backup left in place; main.js's boot-time cleanup deletes
# backups older than 7 days on the next launch.
# ---------------------------------------------------------------------------
write_status success done ""
echo "[$(ts)] backup preserved at $BACKUP (auto-cleanup after 7 days)"
echo "[$(ts)] DONE"
EXPECTED_EXIT=0
exit 0
