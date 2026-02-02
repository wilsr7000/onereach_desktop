#!/bin/bash

# Quick Start Script for AI Conversation Capture Tests
# Usage: ./test/run-ai-conversation-tests.sh [options]

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  AI Conversation Capture E2E Test Suite           ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════╝${NC}"
echo ""

# Check if Playwright is installed
if ! command -v npx &> /dev/null; then
    echo -e "${RED}✗ Error: npx not found. Please install Node.js${NC}"
    exit 1
fi

# Check if playwright is installed
if ! npm list @playwright/test &> /dev/null; then
    echo -e "${YELLOW}⚠ Playwright not found. Installing...${NC}"
    npm install --save-dev @playwright/test
    npx playwright install
fi

# Parse arguments
MODE="run"
HEADED=""
DEBUG=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --headed|-h)
            HEADED="--headed"
            shift
            ;;
        --debug|-d)
            DEBUG="PWDEBUG=1"
            shift
            ;;
        --ui|-u)
            MODE="ui"
            shift
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            echo "Usage: $0 [--headed] [--debug] [--ui]"
            exit 1
            ;;
    esac
done

# Set test mode environment
export TEST_MODE=true
export NODE_ENV=test

echo -e "${GREEN}✓ Environment configured${NC}"
echo -e "  TEST_MODE=${TEST_MODE}"
echo -e "  NODE_ENV=${NODE_ENV}"
echo ""

# Run tests
if [ "$MODE" = "ui" ]; then
    echo -e "${BLUE}▶ Launching Playwright UI...${NC}"
    npx playwright test test/e2e/ai-conversation-capture.spec.js --ui
elif [ -n "$DEBUG" ]; then
    echo -e "${BLUE}▶ Launching Playwright Inspector...${NC}"
    PWDEBUG=1 npx playwright test test/e2e/ai-conversation-capture.spec.js $HEADED
else
    echo -e "${BLUE}▶ Running AI Conversation Capture tests...${NC}"
    echo ""
    npx playwright test test/e2e/ai-conversation-capture.spec.js $HEADED
fi

# Check exit code
if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}╔════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║  ✓ All tests passed!                              ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════╝${NC}"
    exit 0
else
    echo ""
    echo -e "${RED}╔════════════════════════════════════════════════════╗${NC}"
    echo -e "${RED}║  ✗ Some tests failed. Check output above.         ║${NC}"
    echo -e "${RED}╚════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${YELLOW}Tip: View detailed report with:${NC}"
    echo -e "  npx playwright show-report test-results/html"
    exit 1
fi
