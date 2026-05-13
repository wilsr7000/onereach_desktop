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

# Trap to catch unexpected exits. The flag flips to "expected" only when we
# reach an explicit success or fail step that has already written the status
# file. If the script dies in between (uncaught error, kill -9, OOM, etc.) the
# flag is still "unexpected" and the trap writes a clear status. Inverting the
# previous logic: the old version checked `EXPECTED_EXIT = "0"` which was the
# default AND the success path's value, so the trap fired on success and
# overwrote the "success" status file with "failed unknown". Cosmetic but
# visible bug -- fixed here.
REACHED_EXPECTED_EXIT=0
trap 'if [ "$REACHED_EXPECTED_EXIT" = "0" ]; then write_status failed unknown "helper exited unexpectedly"; fi' EXIT

# ---------------------------------------------------------------------------
# Pre-flight env validation
# ---------------------------------------------------------------------------
if [ -z "$PARENT_PID" ] || [ -z "$APP_PATH" ] || [ -z "$SHIPIT_CACHE" ]; then
    echo "[$(ts)] FATAL: missing required env vars"
    echo "  PARENT_PID=$PARENT_PID"
    echo "  APP_PATH=$APP_PATH"
    echo "  SHIPIT_CACHE=$SHIPIT_CACHE"
    write_status failed starting "missing required env vars"
    REACHED_EXPECTED_EXIT=1
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
# Concurrent-install lock. If two helpers race (e.g. user double-clicked
# "Install and Restart" in the dialog), both would try to mv the same
# /Applications/<bundle>.app aside and ditto over it, with non-deterministic
# results. Use flock-style locking via mkdir (atomic on macOS) on a path
# derived from the bundle so two installs to different bundles can coexist.
# ---------------------------------------------------------------------------
LOCK_DIR="/tmp/onereach-lite-installer.$(echo "$APP_PATH" | tr '/' '_' | tr ' ' '_').lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    # Another helper already holds the lock. Check if its parent is still
    # alive. If the holder is dead, we steal the lock; otherwise we bail
    # so we don't double-install.
    LOCK_AGE=$(($(date +%s) - $(stat -f %m "$LOCK_DIR" 2>/dev/null || echo 0)))
    if [ "$LOCK_AGE" -gt 300 ]; then
        echo "[$(ts)] stale lock dir (${LOCK_AGE}s old) -- stealing it"
        rm -rf "$LOCK_DIR" 2>/dev/null || true
        mkdir "$LOCK_DIR" 2>/dev/null || true
    else
        echo "[$(ts)] another helper is already running (lock held ${LOCK_AGE}s), bailing"
        write_status failed starting "another install helper is already running"
        REACHED_EXPECTED_EXIT=1
        exit 1
    fi
fi
# Best-effort lock release on exit (any exit, success or failure).
trap 'rm -rf "$LOCK_DIR" 2>/dev/null || true; if [ "$REACHED_EXPECTED_EXIT" = "0" ]; then write_status failed unknown "helper exited unexpectedly"; fi' EXIT
echo "[$(ts)] acquired install lock at $LOCK_DIR"

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
#
# When multiple `update.*` directories exist (e.g. from previous failed
# attempts that left stale staging), iterate over them NEWEST FIRST and
# validate the version inside each one matches TARGET_VERSION. This
# prevents installing a stale bundle that happens to have the right
# bundle name but wrong version.
# ---------------------------------------------------------------------------
write_status pending find_bundle ""

# Helper: read CFBundleShortVersionString from an .app's Info.plist. Returns
# "" if the file is missing or the key isn't readable.
bundle_version() {
    local app="$1"
    /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$app/Contents/Info.plist" 2>/dev/null || echo ""
}

NEW_APP=""
# Sort by modification time, newest first. Without this we'd just pick
# the first alphabetical match which could be the oldest stale dir.
if compgen -G "$SHIPIT_CACHE/update.*" >/dev/null 2>&1; then
    while IFS= read -r d; do
        candidate="$d/$BUNDLE_NAME"
        if [ -d "$candidate" ]; then
            ver=$(bundle_version "$candidate")
            if [ -n "$TARGET_VERSION" ] && [ "$TARGET_VERSION" != "unknown" ] && [ -n "$ver" ] && [ "$ver" != "$TARGET_VERSION" ]; then
                echo "[$(ts)] skipping stale Squirrel cache $candidate (version $ver != $TARGET_VERSION)"
                continue
            fi
            NEW_APP="$candidate"
            echo "[$(ts)] picked Squirrel cache: $NEW_APP (version $ver)"
            break
        fi
    done < <(ls -t -d "$SHIPIT_CACHE"/update.* 2>/dev/null)
fi

if [ -z "$NEW_APP" ]; then
    echo "[$(ts)] no usable Squirrel cache, extracting from electron-updater ZIP"
    if [ -z "$UPDATER_CACHE" ]; then
        write_status failed find_bundle "no Squirrel cache and no UPDATER_CACHE provided"
        REACHED_EXPECTED_EXIT=1
        exit 1
    fi
    # Pick the NEWEST zip in the cache, not the first alphabetical.
    ZIP=$(ls -t "$UPDATER_CACHE"/*.zip 2>/dev/null | head -1)
    if [ -z "$ZIP" ]; then
        echo "[$(ts)] FATAL: no update bundle found in either cache"
        write_status failed find_bundle "no update bundle found in Squirrel cache or updater cache"
        REACHED_EXPECTED_EXIT=1
        exit 1
    fi
    EXTRACT_DIR=$(mktemp -d)
    echo "[$(ts)] extracting $ZIP -> $EXTRACT_DIR"
    if ! ditto -x -k "$ZIP" "$EXTRACT_DIR"; then
        write_status failed find_bundle "ditto -x failed extracting ZIP"
        REACHED_EXPECTED_EXIT=1
        exit 1
    fi
    NEW_APP="$EXTRACT_DIR/$BUNDLE_NAME"
fi

if [ ! -d "$NEW_APP" ]; then
    echo "[$(ts)] FATAL: NEW_APP path doesn't exist: $NEW_APP"
    write_status failed find_bundle "resolved bundle path does not exist: $NEW_APP"
    REACHED_EXPECTED_EXIT=1
    exit 1
fi

# Final version sanity check. If the bundle we located doesn't match the
# target version, refuse rather than silently installing the wrong one.
# Skipped when TARGET_VERSION is "unknown" (rare edge case where the
# performUpdateInstall call didn't pass a target).
NEW_VER=$(bundle_version "$NEW_APP")
if [ -n "$TARGET_VERSION" ] && [ "$TARGET_VERSION" != "unknown" ] && [ -n "$NEW_VER" ] && [ "$NEW_VER" != "$TARGET_VERSION" ]; then
    echo "[$(ts)] FATAL: bundle version mismatch ($NEW_VER != $TARGET_VERSION)"
    write_status failed find_bundle "located bundle version $NEW_VER does not match target $TARGET_VERSION"
    REACHED_EXPECTED_EXIT=1
    exit 1
fi
echo "[$(ts)] new bundle: $NEW_APP (version $NEW_VER)"

# ---------------------------------------------------------------------------
# 3. Verify the new bundle's signature before swapping. If this fails,
# refuse to install -- bad bundle is worse than a stale bundle.
# ---------------------------------------------------------------------------
write_status pending verify_codesign ""
if ! codesign --verify "$NEW_APP" 2>/dev/null; then
    echo "[$(ts)] FATAL: codesign --verify failed on new bundle"
    write_status failed verify_codesign "codesign --verify failed on new bundle"
    REACHED_EXPECTED_EXIT=1
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
    REACHED_EXPECTED_EXIT=1
    exit 1
fi

echo "[$(ts)] ditto new bundle into $APP_PATH"
if ! ditto "$NEW_APP" "$APP_PATH"; then
    echo "[$(ts)] FATAL: ditto failed, rolling back"
    rm -rf "$APP_PATH" 2>/dev/null || true
    mv "$BACKUP" "$APP_PATH" 2>/dev/null || true
    write_status failed swap "ditto into /Applications failed, rolled back to previous version"
    REACHED_EXPECTED_EXIT=1
    exit 1
fi

# Strip quarantine just in case (newly-built bundles don't get tagged,
# but it's cheap insurance).
xattr -d com.apple.quarantine "$APP_PATH" 2>/dev/null || true

# Post-install version verification. Read the version from the just-installed
# bundle's Info.plist. If it doesn't match the target, something went badly
# wrong during ditto -- roll back to the backup and report. This catches the
# case where Squirrel.Mac left a stale staging dir that passed find_bundle's
# version check but was actually a different bundle than ditto saw.
INSTALLED_VER=$(bundle_version "$APP_PATH")
if [ -n "$TARGET_VERSION" ] && [ "$TARGET_VERSION" != "unknown" ] && [ -n "$INSTALLED_VER" ] && [ "$INSTALLED_VER" != "$TARGET_VERSION" ]; then
    echo "[$(ts)] FATAL: post-install version mismatch ($INSTALLED_VER != $TARGET_VERSION), rolling back"
    rm -rf "$APP_PATH" 2>/dev/null || true
    mv "$BACKUP" "$APP_PATH" 2>/dev/null || true
    write_status failed swap "post-install version mismatch: got $INSTALLED_VER, expected $TARGET_VERSION (rolled back)"
    REACHED_EXPECTED_EXIT=1
    exit 1
fi
echo "[$(ts)] installed version verified: $INSTALLED_VER"

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
# 6. Cleanup. Old backups (.app.old.<ts>) accumulate after every successful
# install. Delete the ones older than 7 days; keep more recent ones in case
# the user needs to roll back manually. Best-effort -- failure to clean up
# does not affect the install outcome.
# ---------------------------------------------------------------------------
CLEANUP_PARENT="$(dirname "$APP_PATH")"
CLEANUP_PATTERN="$(basename "$APP_PATH").old."
echo "[$(ts)] cleaning backups older than 7 days in $CLEANUP_PARENT"
# Use find -mtime +7 (older than 7 days). The pattern is escaped via
# -name "<basename>.old.*" to handle the space in "Onereach.ai Lite.app".
find "$CLEANUP_PARENT" -maxdepth 1 -name "$CLEANUP_PATTERN*" -type d -mtime +7 -print -exec rm -rf {} + 2>/dev/null || true

write_status success done ""
echo "[$(ts)] backup preserved at $BACKUP (auto-cleanup after 7 days)"
echo "[$(ts)] DONE"
REACHED_EXPECTED_EXIT=1
exit 0
