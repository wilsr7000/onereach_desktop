#!/bin/bash

# Run Setup Wizard Test Suite
echo "🧪 Running Setup Wizard Test Suite..."
echo "=================================="

# Set test mode to suppress alerts
export ELECTRON_TEST_MODE=1

# Run tests
npm run test:wizard

# Check exit code
if [ $? -eq 0 ]; then
    echo ""
    echo "✅ All tests passed!"
else
    echo ""
    echo "❌ Some tests failed. Check the test report for details."
    exit 1
fi 