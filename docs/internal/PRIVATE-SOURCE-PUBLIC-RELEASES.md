# Private Source Code with Public Releases Setup

## 🔐 The Strategy

Keep your source code private while allowing public downloads and auto-updates:

1. **Private Repository** (`onereach_desktop`) - Contains source code
2. **Public Repository** (`onereach-desktop-releases`) - Contains only releases

## 📋 Step-by-Step Setup

### Step 1: Create Public Releases Repository

1. Go to https://github.com/new
2. Create a new repository:
   - Name: `onereach-desktop-releases` (or similar)
   - Description: "Onereach.ai Desktop App Releases"
   - **Make it PUBLIC** ✅
   - Initialize with README ✅
   - Don't add .gitignore or license

### Step 2: Update Your App Configuration

The auto-updater needs to point to the PUBLIC repository:

```json
// In package.json, update the publish section:
"publish": [
  {
    "provider": "github",
    "owner": "wilsr7000",
    "repo": "onereach-desktop-releases",  // PUBLIC repo name
    "releaseType": "release"
  }
]
```

### Step 3: Create Release Script for Public Repo

Create `scripts/publish-to-public.sh`:

```bash
#!/bin/bash

# This script publishes releases to the PUBLIC repository
# while keeping source code in the PRIVATE repository

PUBLIC_REPO="wilsr7000/onereach-desktop-releases"
PRIVATE_REPO="wilsr7000/onereach_desktop"

echo "🔒 Publishing release from private to public repository"
echo "=================================================="

# Get version from package.json
VERSION=$(node -p "require('./package.json').version")
echo "📦 Version: $VERSION"

# Check if release files exist
FILES=(
    "dist/Onereach.ai-${VERSION}-arm64.dmg"
    "dist/Onereach.ai-${VERSION}-arm64-mac.zip"
    "dist/Onereach.ai-${VERSION}.dmg"
    "dist/Onereach.ai-${VERSION}-mac.zip"
    "dist/latest-mac.yml"
)

echo "✅ Checking files..."
for FILE in "${FILES[@]}"; do
    if [ ! -f "$FILE" ]; then
        echo "❌ Missing: $FILE"
        echo "Run build commands first!"
        exit 1
    fi
    echo "✅ Found: $FILE"
done

echo ""
echo "📤 Creating release on PUBLIC repository..."
echo "Repository: $PUBLIC_REPO"
echo ""

# Create release on PUBLIC repo
gh release create "v$VERSION" \
    "${FILES[@]}" \
    --repo "$PUBLIC_REPO" \
    --title "Onereach.ai Desktop v$VERSION" \
    --notes "### Download Instructions

**For Apple Silicon Macs (M1/M2/M3):**
- Download: \`Onereach.ai-${VERSION}-arm64.dmg\`

**For Intel Macs:**
- Download: \`Onereach.ai-${VERSION}.dmg\`

### What's New
- Auto-update support
- Bug reporting feature
- Performance improvements

### Auto-Updates
The app will automatically check for updates and notify you when a new version is available.

---
*Note: This is a public releases repository. Source code is maintained privately.*"

echo ""
echo "✅ Release published to PUBLIC repository!"
echo "🔗 Public URL: https://github.com/$PUBLIC_REPO/releases/tag/v$VERSION"
echo ""
echo "Users can now:"
echo "1. Download from the public releases page"
echo "2. Receive auto-updates in their installed apps"
```

### Step 4: Workflow for Future Releases

```bash
# 1. Work in your PRIVATE repository
cd ~/Onereach_app

# 2. Update version in package.json
# Edit package.json: "version": "1.0.5"

# 3. Commit to PRIVATE repo
git add .
git commit -m "Release v1.0.5"
git push origin main

# 4. Build the app
npm run package:mac
npx electron-builder build --mac --x64 --publish never

# 5. Publish to PUBLIC repo
./scripts/publish-to-public.sh
```

## 🎯 Benefits of This Approach

✅ **Source code stays private** - No one can see your code
✅ **Releases are public** - Anyone can download the app
✅ **Auto-updates work** - Users get notified of new versions
✅ **Clean separation** - Development vs Distribution
✅ **Professional appearance** - Users only see polished releases

## 🔄 Auto-Update Flow

1. User's app checks: `https://github.com/wilsr7000/onereach-desktop-releases/releases`
2. Finds new version → Shows notification
3. Downloads from public releases
4. Installs on restart

## 📝 Important Notes

### Public Repo README
Create a nice README for the public repo with:
- App description and features
- Download instructions
- System requirements
- No source code or implementation details

### Version Tags
Always use consistent version tags:
- Private repo: Can use any commit messages
- Public repo: Use clean tags like `v1.0.4`

### Security
- Never commit sensitive files to public repo
- Only upload built `.dmg`, `.zip`, and `latest-mac.yml`
- Keep all source, configs, and scripts in private repo

## 🚀 Alternative Options

### Option 2: GitHub Pages for Downloads
- Host releases on GitHub Pages
- Point auto-updater to Pages URL
- More complex but allows custom download page

### Option 3: Custom Server
- Host your own update server
- Complete control over distribution
- Requires server maintenance

### Option 4: Code Signing + Notarization
- Get Apple Developer account ($99/year)
- Sign and notarize apps
- Users trust your app more
- Can distribute outside GitHub

## 💡 Recommendation

**Use Option 1 (Separate Public Repo)** because:
- Free and simple
- Works with existing auto-updater
- Professional appearance
- Easy to maintain
- Standard practice for many apps

Ready to set this up? Create the public repository first, then I'll update your configuration!
