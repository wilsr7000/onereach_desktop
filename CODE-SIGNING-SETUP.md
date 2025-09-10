# Code Signing Password Storage Options

## Option 1: macOS Keychain (Recommended)
This is the most secure and convenient method on macOS.

### Allow Certificate Access Without Password
1. Open **Keychain Access** app
2. Find your Developer ID certificate in "My Certificates"
3. Right-click the certificate → Get Info
4. Click the **Access Control** tab
5. Select "Allow all applications to access this item"
6. Or add specific apps: Click the + button and add:
   - `/usr/bin/codesign`
   - Your Terminal app
   - electron-builder
7. Click **Save Changes**

### Set Certificate to "Always Allow"
1. When prompted for password during build
2. Enter your password
3. Click "Always Allow" instead of "Allow"

## Option 2: Environment Variables

### Temporary (Current Session Only)
```bash
export CSC_KEY_PASSWORD="your-password"
npm run package:mac
```

### Permanent (Add to Shell Profile)
Add to `~/.zshrc` or `~/.bash_profile`:
```bash
export CSC_KEY_PASSWORD="your-password"
export CSC_IDENTITY_AUTO_DISCOVERY=true
```

Then reload:
```bash
source ~/.zshrc
```

## Option 3: .env File (Use with Caution)
**⚠️ Warning: Never commit .env files to version control!**

1. Create `.env` file in project root:
```
CSC_KEY_PASSWORD=your-password
CSC_IDENTITY_AUTO_DISCOVERY=true
```

2. Add to `.gitignore`:
```
.env
.env.local
```

3. Create a build script `build-with-env.js`:
```javascript
require('dotenv').config();
const { spawn } = require('child_process');

const build = spawn('npm', ['run', 'package:mac'], {
  stdio: 'inherit',
  env: { ...process.env }
});

build.on('close', (code) => {
  process.exit(code);
});
```

4. Add to package.json:
```json
"scripts": {
  "build:signed": "node build-with-env.js"
}
```

## Option 4: Build Script with Keychain Integration
Create `scripts/build-signed.sh`:
```bash
#!/bin/bash

# Unlock keychain (will prompt once)
security unlock-keychain ~/Library/Keychains/login.keychain-db

# Set session keychain
security set-key-partition-list -S apple-tool:,apple: -s -k "" ~/Library/Keychains/login.keychain-db

# Run build
npm run package:mac
```

Make it executable:
```bash
chmod +x scripts/build-signed.sh
```

Run with:
```bash
./scripts/build-signed.sh
```

## Option 5: Disable Code Signing (Development Only)
For development builds, you can temporarily disable signing:

```bash
export CSC_IDENTITY_AUTO_DISCOVERY=false
npm run package:mac
```

Or in package.json:
```json
"scripts": {
  "package:mac:unsigned": "CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder build --mac --publish never"
}
```

## Security Best Practices
1. **Never hardcode passwords in code**
2. **Don't commit credentials to version control**
3. **Use Keychain Access method for production builds**
4. **Rotate passwords regularly**
5. **Use different passwords for different certificates**

## Troubleshooting

### "User interaction is not allowed" Error
```bash
# Allow codesign to access keychain
security set-key-partition-list -S apple-tool:,apple: -s -k "your-keychain-password" ~/Library/Keychains/login.keychain-db
```

### Certificate Not Found
```bash
# List available certificates
security find-identity -v -p codesigning

# Set specific identity
export CSC_NAME="Developer ID Application: Your Name (TEAMID)"
```

### Multiple Keychains
```bash
# Set default keychain
security default-keychain -s ~/Library/Keychains/login.keychain-db

# Add to search list
security list-keychains -s ~/Library/Keychains/login.keychain-db
``` 