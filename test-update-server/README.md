# Local Update Testing

Test auto-update functionality locally without publishing to GitHub.

## Quick Start

### 1. Enable Local Update Server

Edit `dev-app-update.yml` and uncomment these lines:

```yaml
provider: generic
url: http://localhost:8080/
```

Comment out the GitHub provider:

```yaml
# owner: OneReachAI
# repo: desktop-app
# provider: github
```

### 2. Build the New Version

```bash
# Build version 1.0.12 (or whatever version you bumped to)
npm run package:mac
```

This creates files in `dist/`:
- `Onereach.ai-1.0.12-arm64-mac.zip`
- `latest-mac.yml`
- `Onereach.ai-1.0.12-arm64.dmg` (optional)

### 3. Copy Files to Test Server

```bash
# Copy the update files
cp dist/latest-mac.yml test-update-server/updates/
cp dist/Onereach.ai-1.0.12-arm64-mac.zip test-update-server/updates/
cp dist/Onereach.ai-1.0.12-arm64-mac.zip.blockmap test-update-server/updates/ 2>/dev/null || true
```

### 4. Start the Local Update Server

```bash
# In one terminal window:
node test-update-server/server.js
```

You should see:
```
🚀 Local Update Server Running
📍 Server: http://localhost:8080
📁 Serving: /path/to/test-update-server/updates
```

### 5. Run Your App in Dev Mode

```bash
# In another terminal window:
npm run dev
```

Your app should:
1. Start with version 1.0.11 (or whatever version you're currently on)
2. Check the local server for updates
3. Find version 1.0.12
4. Show "Update Available" notification
5. Download and install when you click "Download"

## Testing Flow

### Expected Behavior

1. **App Starts**
   - Current version: 1.0.11
   - Checks: http://localhost:8080/latest-mac.yml
   - Finds: 1.0.12 available

2. **User Sees Notification**
   - "A new version (1.0.12) is available!"
   - Option to Download or Later

3. **User Clicks Download**
   - Downloads: http://localhost:8080/Onereach.ai-1.0.12-arm64-mac.zip
   - Shows progress
   - "Update Ready to Install"

4. **User Restarts App**
   - Installs update
   - Launches version 1.0.12
   - Success! ✓

### Troubleshooting

**"No updates available"**
- Check dev-app-update.yml is configured for local server
- Verify update server is running on port 8080
- Check files exist in updates/ folder

**"Failed to download update"**
- Check file permissions on .zip file
- Verify .zip file is not corrupted
- Check console for error messages

**Update server won't start**
- Port 8080 might be in use
- Change PORT in server.js
- Update url in dev-app-update.yml

## File Structure

```
test-update-server/
├── server.js           ← Local HTTP server
├── README.md          ← This file
└── updates/           ← Put your build files here
    ├── latest-mac.yml
    ├── Onereach.ai-1.0.12-arm64-mac.zip
    └── Onereach.ai-1.0.12-arm64-mac.zip.blockmap
```

## Clean Up After Testing

When done testing, restore `dev-app-update.yml`:

```yaml
owner: OneReachAI
repo: desktop-app
provider: github
# provider: generic
# url: http://localhost:8080/
```

## Production Release

When ready for production:

1. Commit your changes
2. Tag the version: `git tag v1.0.12`
3. Push: `git push origin main --tags`
4. Build and publish: `npm run publish:mac`

Or use GitHub CLI:

```bash
gh release create v1.0.12 \
  dist/Onereach.ai-1.0.12-arm64-mac.zip \
  dist/Onereach.ai-1.0.12-arm64.dmg \
  dist/latest-mac.yml \
  --title "v1.0.12" \
  --notes "Release notes here"
```
