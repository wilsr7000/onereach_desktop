# Onereach.ai v3.8.13 - Critical Launch Fix

## 🔧 Critical Fixes

### App Launch Error Fixed
- **Fixed:** "js undefined undefined" error preventing app launch
- **Fixed:** Missing `closeAllGSXWindows` import in main.js
- **Fixed:** Rebuilt keytar native module for ARM64 (Apple Silicon) compatibility

## 📦 What's Included

This is a critical hotfix release that addresses a launch failure introduced in v3.8.12. If you're unable to launch v3.8.12, please update to this version immediately.

## 🎯 Previous Release Features (v3.8.12)

For reference, the previous release included:
- **Zombie Window Prevention:** IPC heartbeat system keeps windows responsive
- **App Quit Improvements:** Graceful shutdown with forced window cleanup
- **GSX Window Management:** Enhanced close handling and tracking
- **Close Button:** Added convenience close button to GSX toolbar

## 📥 Installation

### For Apple Silicon Macs (M1/M2/M3/M4)
Download: **Onereach.ai-3.8.13-arm64.dmg**

### For Intel Macs
Download: **Onereach.ai-3.8.13.dmg**

### First-Time Installation
1. Download the appropriate DMG file for your Mac
2. Open the DMG and drag Onereach.ai to your Applications folder
3. Right-click the app and select "Open" to bypass Gatekeeper (first time only)
4. Click "Open" in the security dialog

### Auto-Update
If you're already running v3.8.12 or earlier, the app will auto-update to v3.8.13.

## 🔐 Security Note

This app is signed with a valid Apple Developer certificate but not yet notarized. You'll need to right-click and select "Open" on first launch.

## 🐛 Known Issues

- Notarization not yet implemented (requires Apple Developer account)
- Windows version not yet available

## 📝 Full Changelog

**v3.8.13** (2026-01-17)
- Fix: Added missing closeAllGSXWindows import to main.js
- Fix: Rebuilt keytar for ARM64 architecture compatibility
- Fix: Resolves "js undefined undefined" launch error

**v3.8.12** (2026-01-17)
- New: IPC heartbeat system with smart 4-minute idle detection
- New: Zombie window detection with emergency UI banner
- New: App lifecycle handlers (before-quit, window-all-closed, will-quit)
- New: GSX window tracking and forced close logic
- New: Close button in GSX toolbar
- Fix: App not quitting when windows remain open
- Fix: Windows becoming unresponsive after several hours

---

**Need Help?** Open an issue on GitHub or contact support.
