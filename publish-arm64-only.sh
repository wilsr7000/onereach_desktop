#!/bin/bash

# Quick publish script for ARM64 build only
# This is a convenience wrapper around release-master.sh

echo "Running ARM64-only release (quick mode)..."
echo ""
./scripts/release-master.sh --arm64-only "$@"
