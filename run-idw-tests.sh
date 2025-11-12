#!/bin/bash

echo "🧪 Running IDW Management Tests..."
echo ""

cd "$(dirname "$0")"

# Run the test suite
./node_modules/.bin/electron test-idw-management.js

echo ""
echo "✅ Tests complete!"


