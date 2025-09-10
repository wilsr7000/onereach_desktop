# Local Update Server Testing

This directory is for testing auto-updates locally.

## Quick Start

1. Build your app:
   ```bash
   npm run package:mac
   ```

2. Copy update files here:
   ```bash
   cp dist/latest-mac*.yml test-update-server/
   cp dist/*.dmg test-update-server/
   cp dist/*.zip* test-update-server/
   ```

3. Start local server:
   ```bash
   cd test-update-server
   python3 -m http.server 8080
   ```

4. Update dev-app-update.yml:
   ```yaml
   provider: generic
   url: http://localhost:8080/
   ```

5. Run the app in dev mode:
   ```bash
   npm run dev
   ```

6. Test update flow through Help → Check for Updates 