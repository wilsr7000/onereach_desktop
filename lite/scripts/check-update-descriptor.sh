#!/usr/bin/env bash
# Updater descriptor gate (ADR-101). Usage: check-update-descriptor.sh <path/to/App.app>
# Exit 0 when Contents/Resources/app-update.yml exists and is EXACTLY the
# feed in lite/updater/feed.ts (four lines, anchored); exit 1 otherwise.
# Called by release-lite.sh and executed by updater-feed-guards.test.ts.
set -u
BUNDLE="${1:-}"
RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'
if [ -z "$BUNDLE" ] || [ ! -d "$BUNDLE" ]; then
    echo -e "${RED}✗ Updater descriptor gate: no app bundle to check (got '${BUNDLE}'). Aborting.${NC}"
    exit 1
fi
DESCRIPTOR="$BUNDLE/Contents/Resources/app-update.yml"
if [ ! -f "$DESCRIPTOR" ]; then
    echo -e "${RED}✗ ${DESCRIPTOR} is missing — the installed app could never check for updates. Aborting.${NC}"
    exit 1
fi
EXPECTED=$'owner: wilsr7000\nrepo: Onereach_Lite_Desktop_App\nprovider: github\nupdaterCacheDirName: onereach-lite-updater'
ACTUAL=$(sed -e 's/[[:space:]]*$//' -e '/^[[:space:]]*$/d' -e '/^#/d' "$DESCRIPTOR")
if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo -e "${RED}✗ ${DESCRIPTOR} does not name the feed in lite/updater/feed.ts exactly. Aborting.${NC}"
    echo "--- expected"; echo "$EXPECTED"; echo "--- actual"; cat "$DESCRIPTOR"
    exit 1
fi
echo -e "${GREEN}✓ Updater descriptor present and exact: $(echo "$EXPECTED" | tr '\n' ' ')${NC}"
exit 0
