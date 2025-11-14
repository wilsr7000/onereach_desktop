#!/bin/bash

# Setup git hooks to protect black hole widget functionality

echo "Setting up Git hooks to protect critical functionality..."

# Create hooks directory if it doesn't exist
mkdir -p .git/hooks

# Create pre-commit hook
cat > .git/hooks/pre-commit << 'EOF'
#!/bin/bash

# Run black hole widget integrity test before committing
echo "Running Black Hole Widget integrity check..."

node test-black-hole.js

if [ $? -ne 0 ]; then
  echo ""
  echo "❌ Black Hole Widget integrity check failed!"
  echo "Please fix the errors before committing."
  echo "See TEST-BLACKHOLE.md for troubleshooting."
  exit 1
fi

echo "✅ Black Hole Widget integrity check passed"
EOF

# Make hook executable
chmod +x .git/hooks/pre-commit

echo "✅ Git hooks installed successfully!"
echo ""
echo "The pre-commit hook will now check the black hole widget integrity"
echo "before each commit to prevent breaking changes."
echo ""
echo "To bypass the check in emergencies, use: git commit --no-verify"
