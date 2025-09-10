# Onereach.ai Desktop App - Test Plan

## Overview
This test plan covers functional, integration, and cross-platform testing for the Onereach.ai desktop application.

**Version**: 1.0.3  
**Platforms**: macOS (primary), Windows (secondary)  
**Test Environment**: Production build and development mode

## 🧬 Integrated Test Runner
The application now includes an integrated test runner for automated testing and manual test tracking:
- **Access**: Press `Cmd+Alt+H` to activate test menu, then Help → 🧬 Integrated Test Runner
- **Features**: Automated tests, manual checklists, test history, report export
- **Documentation**: See [TEST-RUNNER-GUIDE.md](./TEST-RUNNER-GUIDE.md) for full details

Use the integrated test runner to execute many of the test cases listed below automatically.

## Test Categories

### 1. Core Functionality Tests

#### 1.1 Clipboard Monitoring
| Test Case | Steps | Expected Result | Platform |
|-----------|-------|-----------------|----------|
| Text Copy | 1. Copy plain text<br>2. Check clipboard history | Text appears in history with preview | Both |
| Code Copy | 1. Copy code from IDE<br>2. Check source detection | Code detected with syntax highlighting | Both |
| HTML Copy | 1. Copy formatted text from web<br>2. Check dual format | Both HTML and plain text saved | Both |
| Image Copy | 1. Copy image<br>2. Check thumbnail | Image saved with thumbnail | Both |
| File Path | 1. Copy file path<br>2. Check detection | Path detected and file info shown | Both |
| URL Copy | 1. Copy URL<br>2. Check detection | URL detected with link preview | Both |

#### 1.2 Black Hole Widget
| Test Case | Steps | Expected Result | Platform |
|-----------|-------|-----------------|----------|
| Widget Display | 1. Cmd/Ctrl+Shift+V<br>2. Check widget | Widget appears at saved position | Both |
| Drag Text File | 1. Drag .txt file to widget<br>2. Check preview | File accepted, preview shown | Mac only |
| Drag PDF | 1. Drag PDF to widget<br>2. Check thumbnail | PDF accepted with thumbnail | Mac only |
| Drag Image | 1. Drag image to widget<br>2. Check processing | Image saved with metadata | Both |
| Space Selection | 1. Drag file<br>2. Select space in modal | File saved to selected space | Both |
| Widget Position | 1. Move widget<br>2. Close and reopen | Position remembered | Both |

#### 1.3 Spaces Management
| Test Case | Steps | Expected Result | Platform |
|-----------|-------|-----------------|----------|
| Create Space | 1. Create new space<br>2. Set icon and color | Space created with notebook | Both |
| Move Item | 1. Select item<br>2. Move to different space | Item moved, counts updated | Both |
| Delete Space | 1. Delete non-empty space<br>2. Check items | Items moved to Unclassified | Both |
| Space Filter | 1. Select space<br>2. View items | Only space items shown | Both |
| Edit Space | 1. Edit space details<br>2. Save changes | Changes persisted | Both |

### 2. Platform-Specific Tests

#### 2.1 macOS-Specific Features
| Test Case | Steps | Expected Result | Status |
|-----------|-------|-----------------|---------|
| PDF Thumbnails | 1. Add PDF<br>2. Check thumbnail | Native PDF preview shown | ✅ Working |
| App Context | 1. Copy from Safari<br>2. Check source | Shows "Safari" as source | ✅ Working |
| Screenshot Detection | 1. Take screenshot<br>2. Check auto-capture | Screenshot auto-added | ✅ Working |
| Quick Look | 1. Select PDF<br>2. Press Space | Quick Look preview | ✅ Working |

#### 2.2 Windows-Specific Tests
| Test Case | Steps | Expected Result | Status |
|-----------|-------|-----------------|---------|
| PDF Fallback | 1. Add PDF<br>2. Check icon | Generic PDF icon shown | ⚠️ Degraded |
| App Context | 1. Copy from Chrome<br>2. Check source | Shows "Unknown" | ⚠️ Degraded |
| File Paths | 1. Copy C:\path<br>2. Check handling | Path handled correctly | ✅ Should work |
| Permissions | 1. Save to protected folder<br>2. Check error | Graceful error handling | ✅ Should work |

### 3. IDW Integration Tests

#### 3.1 IDW Browser
| Test Case | Steps | Expected Result | Platform |
|-----------|-------|-----------------|----------|
| Open IDW | 1. Select IDW from menu<br>2. Check window | IDW loads in app window | Both |
| Chat Navigation | 1. Open chat URL<br>2. Check navigation | Chat interface loads | Both |
| GSX Links | 1. Click GSX tool<br>2. Check opening | Tool opens in browser | Both |
| Multiple IDWs | 1. Open 2+ IDWs<br>2. Check windows | Each in separate window | Both |
| Auth Flow | 1. Login to IDW<br>2. Check persistence | Session maintained | Both |

### 4. Export Features

#### 4.1 Smart Export
| Test Case | Steps | Expected Result | Platform |
|-----------|-------|-----------------|----------|
| Generate Export | 1. Select items<br>2. Export as article | Formatted document created | Both |
| Style Guide | 1. Apply style<br>2. Check formatting | Style correctly applied | Both |
| PDF Export | 1. Export to PDF<br>2. Check output | Valid PDF generated | Both |
| Template Selection | 1. Choose template<br>2. Generate | Template structure used | Both |
| Regenerate | 1. Click regenerate<br>2. Check new version | New content generated | Both |

### 5. Settings & Preferences

| Test Case | Steps | Expected Result | Platform |
|-----------|-------|-----------------|----------|
| API Keys | 1. Add API key<br>2. Test connection | Key saved securely | Both |
| Spaces Toggle | 1. Disable spaces<br>2. Check UI | Spaces UI hidden | Both |
| Screenshot Toggle | 1. Disable screenshots<br>2. Take screenshot | Not auto-captured | Mac |
| Clear History | 1. Clear all<br>2. Check storage | History cleared, files remain | Both |

### 6. Auto-Update System

| Test Case | Steps | Expected Result | Platform |
|-----------|-------|-----------------|----------|
| Check Updates | 1. Help → Check Updates<br>2. Check response | Update status shown | Both |
| Download Update | 1. Download available update<br>2. Check progress | Progress bar shown | Both |
| Install Update | 1. Restart to install<br>2. Check version | New version installed | Both |
| Rollback | 1. View backups<br>2. Create restore script | Script generated | Both |

### 7. Error Handling & Edge Cases

| Test Case | Steps | Expected Result | Platform |
|-----------|-------|-----------------|----------|
| Large File | 1. Drag 1GB+ file<br>2. Check handling | Graceful rejection/warning | Both |
| Network Error | 1. Disconnect network<br>2. Use AI features | Offline message shown | Both |
| Corrupt Data | 1. Corrupt settings file<br>2. Launch app | Falls back to defaults | Both |
| Full Disk | 1. Fill disk<br>2. Try to save | Error message shown | Both |
| Special Chars | 1. Use emoji/unicode<br>2. Save item | Characters preserved | Both |

### 8. Performance Tests

| Test Case | Criteria | Expected Result | Platform |
|-----------|----------|-----------------|----------|
| Launch Time | Cold start | < 3 seconds | Both |
| History Load | 1000+ items | < 2 seconds | Both |
| Search Speed | Search 1000 items | < 500ms | Both |
| Memory Usage | After 1 hour | < 500MB | Both |
| CPU Usage | Idle state | < 5% | Both |

### 9. Security Tests

| Test Case | Steps | Expected Result | Platform |
|-----------|-------|-----------------|----------|
| API Key Storage | 1. Check settings file<br>2. Verify encryption | Keys encrypted | Both |
| XSS Prevention | 1. Copy malicious HTML<br>2. View in app | Scripts not executed | Both |
| File Access | 1. Try to access system files<br>2. Check permissions | Access denied | Both |
| Deep Links | 1. Test onereach:// URLs<br>2. Check validation | Only valid URLs work | Both |

## Test Execution Plan

### Phase 1: Smoke Testing (Critical Path)
1. App launches
2. Basic clipboard monitoring works
3. Black hole widget appears
4. Can create and switch spaces
5. Settings save and load

### Phase 2: Functional Testing
- Execute all test cases in sections 1-5
- Document any failures with screenshots
- Verify fixes before proceeding

### Phase 3: Cross-Platform Testing
- Run full test suite on macOS
- Run adapted test suite on Windows
- Document platform differences

### Phase 4: Integration Testing
- Test with real IDW environments
- Test with various file types
- Test with different user workflows

### Phase 5: Performance & Stress Testing
- Load testing with large datasets
- Memory leak detection
- Long-running stability tests

## Bug Severity Levels

- **Critical**: App crashes, data loss, security issues
- **High**: Core features broken, major UX issues
- **Medium**: Secondary features broken, workarounds exist
- **Low**: Cosmetic issues, minor inconveniences

## Test Automation

### Integrated Test Runner
The app includes a built-in test runner with automated tests for:
- Clipboard monitoring and source detection
- Spaces management (create, move, delete)
- Settings persistence and API encryption
- Search functionality and performance
- Memory usage monitoring

Access via: Help → 🧬 Integrated Test Runner (after pressing Cmd+Alt+H)

### Additional Automation Opportunities
1. **Unit Tests**: Advanced clipboard parsing, file detection edge cases
2. **Integration Tests**: Complex IPC communication scenarios
3. **E2E Tests**: Full user workflows with Spectron/Playwright
4. **Performance Tests**: Load testing and benchmarking

## Regression Test Suite

After each release, run:
1. Smoke tests (5 min)
2. Core functionality (30 min)
3. Platform-specific features (15 min)
4. Previous bug fixes (10 min)

## Known Issues & Limitations

### macOS
- Notarization warnings without Apple Developer account

### Windows  
- PDF previews show generic icons
- App context detection not implemented
- Screenshot auto-capture not available
- Multiple fs.watch events need debouncing

### Both Platforms
- Large files (>100MB) may cause performance issues
- Some websites may not paste correctly due to CSP 