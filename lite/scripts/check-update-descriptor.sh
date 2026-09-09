#!/usr/bin/env bash
# Updater descriptor gate (ADR-101). Usage: check-update-descriptor.sh <path/to/App.app>
# Exit 0 when Contents/Resources/app-update.yml exists and carries the four
# keys of lite/updater/feed.ts, each exactly once with exactly its value
# (whole-line, anchored); exit 1 otherwise. Other keys (publisherName on
# Windows, a channel) are allowed — the runtime's descriptorMatchesFeed
# tolerates them too, and the gate must not disagree with it.
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
FAIL=0
for KV in "owner=wilsr7000" "repo=Onereach_Lite_Desktop_App" "provider=github" "updaterCacheDirName=onereach-lite-updater"; do
    KEY="${KV%%=*}"; VAL="${KV#*=}"
    KEY_LINES=$(grep -c -E "^[[:space:]]*${KEY}[[:space:]]*:" "$DESCRIPTOR")
    EXACT_LINES=$(grep -c -E "^[[:space:]]*${KEY}[[:space:]]*:[[:space:]]*${VAL}[[:space:]]*$" "$DESCRIPTOR")
    if [ "$KEY_LINES" != "1" ] || [ "$EXACT_LINES" != "1" ]; then
        echo -e "${RED}✗ ${DESCRIPTOR}: expected exactly one line '${KEY}: ${VAL}' — found ${KEY_LINES} line(s) for the key, ${EXACT_LINES} with that value.${NC}"
        FAIL=1
    fi
done
if [ "$FAIL" != "0" ]; then
    echo -e "${RED}✗ The bundle's app-update.yml does not name the feed in lite/updater/feed.ts. Aborting.${NC}"
    echo "--- actual"; cat "$DESCRIPTOR"
    exit 1
fi
echo -e "${GREEN}✓ Updater descriptor names the feed: github wilsr7000/Onereach_Lite_Desktop_App, cache dir onereach-lite-updater${NC}"
exit 0
