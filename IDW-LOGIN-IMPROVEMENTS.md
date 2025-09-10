# IDW Login Improvements Guide

## Problem
Google and other auth providers are more aggressive with security checks in Electron apps compared to regular Chrome, making login difficult.

## Solutions Implemented

### 1. Enhanced Browser Fingerprinting
We've improved how the app mimics Chrome by:

- **Better User Agent**: Matches Chrome exactly
- **Complete Headers**: Added all Chrome security headers (Sec-Ch-Ua, Sec-Fetch-*, etc.)
- **JavaScript APIs**: Mocked Chrome-specific APIs (navigator.vendor, chrome.runtime, etc.)
- **WebGL/Canvas**: Added fingerprint masking to match Chrome
- **Audio Context**: Modified to match Chrome's implementation

### 2. Cookie Persistence
The app now:
- Monitors auth cookies for important domains
- Saves them between sessions
- Restores them automatically

### 3. Additional Solutions You Can Implement

#### A. Use OneReach SSO (Recommended)
Instead of Google login, use OneReach's single sign-on:
1. Login once to OneReach portal
2. Use that session across all IDW tabs
3. Avoid Google's aggressive checks entirely

#### B. Browser Profile Import
You could add a feature to import Chrome cookies:
```javascript
// Example: Import cookies from Chrome
const chromeCookiesPath = path.join(
  os.homedir(),
  'Library/Application Support/Google/Chrome/Default/Cookies'
);
```

#### C. Auth Token Storage
Store auth tokens securely using Electron's safeStorage API:
```javascript
const { safeStorage } = require('electron');

// Encrypt and store
const encrypted = safeStorage.encryptString('auth-token');
fs.writeFileSync('token.enc', encrypted);

// Decrypt and use
const decrypted = safeStorage.decryptString(fs.readFileSync('token.enc'));
```

#### D. WebView with Persistent Session
Use a dedicated webview for auth that persists:
```javascript
<webview 
  src="https://accounts.google.com"
  partition="persist:auth"
  webpreferences="contextIsolation=false"
/>
```

## Quick Fixes to Try

1. **Clear App Data**: Sometimes old cookies cause issues
   ```bash
   rm -rf ~/Library/Application\ Support/Onereach.ai/
   ```

2. **Use Incognito Mode**: Add a button to open IDW in incognito
   ```javascript
   const incognitoWindow = new BrowserWindow({
     webPreferences: {
       partition: 'incognito-' + Date.now()
     }
   });
   ```

3. **Disable Hardware Acceleration**: Can help with some auth issues
   ```javascript
   app.disableHardwareAcceleration();
   ```

## Best Practice: OneReach SSO Integration

The most reliable solution is to implement OneReach SSO:

1. User logs into OneReach once
2. App requests SSO token
3. Use token for all IDW access
4. No Google login required

This avoids all the Electron detection issues.

## Testing the Improvements

1. Build the app with the new changes
2. Clear all app data first
3. Try logging into an IDW
4. Check if login is smoother

The enhanced fingerprinting should make Google less suspicious of the app. 