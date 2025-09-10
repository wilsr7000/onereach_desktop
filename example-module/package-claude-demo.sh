#!/bin/bash

# Package the Claude Demo module

cd "$(dirname "$0")"

# Create the zip file
zip -r claude-demo.zip claude-demo/

echo "Claude demo module packaged as claude-demo.zip"
echo "You can now install it via Modules > Manage Modules > Install from File" 