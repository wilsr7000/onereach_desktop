# Test Automation Guide - Automated vs Manual Testing

## 🧬 Integrated Test Runner
The Onereach.ai app now includes a built-in test runner that implements many of the automated tests described below:
- **Access**: Press `Cmd+Alt+H`, then Help → 🧬 Integrated Test Runner  
- **Coverage**: Core functionality, spaces management, settings, performance
- **Features**: Automated tests, manual checklists, test history, report export
- **Documentation**: See [TEST-RUNNER-GUIDE.md](./TEST-RUNNER-GUIDE.md) for details

## ✅ Can Be Automated

### 1. **Core Functionality**
| Feature | Automation Method | Complexity |
|---------|------------------|------------|
| Clipboard text monitoring | Spectron + clipboard API | Easy |
| Clipboard image detection | Spectron + clipboard API | Easy |
| Source type detection (URL, code, email) | Unit tests | Easy |
| Item storage and retrieval | Unit tests | Easy |
| Search functionality | Integration tests | Easy |
| History persistence | Integration tests | Easy |

### 2. **Spaces Management**
| Feature | Automation Method | Complexity |
|---------|------------------|------------|
| Create/edit/delete spaces | Integration tests | Easy |
| Move items between spaces | Integration tests | Easy |
| Space filtering | Integration tests | Easy |
| Item counts | Unit tests | Easy |
| Default space creation | Unit tests | Easy |

### 3. **Data Processing**
| Feature | Automation Method | Complexity |
|---------|------------------|------------|
| File path detection | Unit tests | Easy |
| File size formatting | Unit tests | Easy |
| HTML stripping | Unit tests | Easy |
| Text truncation | Unit tests | Easy |
| Metadata generation | Unit tests | Easy |
| Tag auto-generation | Unit tests | Easy |

### 4. **Settings & Storage**
| Feature | Automation Method | Complexity |
|---------|------------------|------------|
| Save/load settings | Integration tests | Easy |
| API key encryption | Unit tests | Easy |
| Preferences persistence | Integration tests | Easy |
| File system operations | Integration tests | Medium |
| Space directory creation | Unit tests | Easy |

### 5. **IPC Communication**
| Feature | Automation Method | Complexity |
|---------|------------------|------------|
| Main ↔ Renderer messaging | Integration tests | Medium |
| Window creation signals | Integration tests | Medium |
| Menu actions | Spectron | Medium |
| Event handling | Integration tests | Easy |

### 6. **Performance Metrics**
| Feature | Automation Method | Complexity |
|---------|------------------|------------|
| Launch time | Spectron + timers | Easy |
| Memory usage | Process monitoring | Easy |
| CPU usage | Process monitoring | Easy |
| Search speed (1000+ items) | Performance tests | Easy |
| File I/O speed | Benchmarks | Easy |

### 7. **Error Handling**
| Feature | Automation Method | Complexity |
|---------|------------------|------------|
| Invalid data handling | Unit tests | Easy |
| File not found errors | Unit tests | Easy |
| Network timeouts | Mock tests | Medium |
| Corrupt settings recovery | Integration tests | Medium |
| API failures | Mock tests | Easy |

### 8. **Export Features** 
| Feature | Automation Method | Complexity |
|---------|------------------|------------|
| Generate export data | Integration tests | Medium |
| Template application | Unit tests | Easy |
| Markdown → HTML conversion | Unit tests | Easy |
| Style guide parsing | Unit tests | Easy |
| Export metadata | Unit tests | Easy |

## ⚠️ Partially Automatable

### 1. **Black Hole Widget**
| Feature | Can Automate | Must Be Manual | Why |
|---------|--------------|----------------|-----|
| Widget creation | ✅ Window exists | ❌ Visual appearance | Transparency/styling |
| Position saving | ✅ Coordinates saved | ❌ Screen boundaries | Display differences |
| File drop events | ✅ Event triggered | ❌ Drag gesture | OS drag/drop APIs |
| Space modal | ✅ Modal opens | ❌ UI interactions | Complex DOM |

### 2. **Platform-Specific Features**
| Feature | Can Automate | Must Be Manual | Why |
|---------|--------------|----------------|-----|
| PDF thumbnail (Mac) | ✅ Function called | ❌ Actual thumbnail | qlmanage binary |
| App context (Mac) | ✅ Mock response | ❌ Real detection | AppleScript |
| File permissions | ✅ Error handling | ❌ Actual chmod | OS permissions |
| Tray icon | ✅ Object created | ❌ Visual display | OS integration |

## ❌ Must Be Manual

### 1. **Visual & UX Testing**
| Feature | Why Manual | What to Check |
|---------|------------|---------------|
| UI appearance | Subjective quality | Layout, colors, fonts |
| Animations | Timing & smoothness | Transitions, hover effects |
| Dark mode | Visual consistency | All UI elements |
| Responsive design | Window resizing | Min/max sizes |
| Icon quality | Visual inspection | Clarity at different sizes |
| Scrolling behavior | Feel & performance | Smooth, no jank |

### 2. **OS Integration**
| Feature | Why Manual | What to Check |
|---------|------------|---------------|
| Drag & drop from Finder | OS gesture | File acceptance |
| System notifications | OS permission | Display correctly |
| Global shortcuts | System-wide | Conflicts with other apps |
| Auto-start on login | OS settings | Persistence |
| Dock/taskbar behavior | OS specific | Right-click menu |

### 3. **Real-World Workflows**
| Feature | Why Manual | What to Check |
|---------|------------|---------------|
| Copy from various apps | App-specific behavior | Source detection |
| Multiple monitors | Display positioning | Widget placement |
| Sleep/wake cycles | OS power management | State restoration |
| Full disk scenarios | Real disk space | Error messages |
| Slow network | Real conditions | Timeout handling |

### 4. **Installation & Updates**
| Feature | Why Manual | What to Check |
|---------|------------|---------------|
| DMG installation (Mac) | OS installer | Drag to Applications |
| Code signing warnings | OS security | Gatekeeper messages |
| Auto-update flow | Real server | Download progress |
| Rollback process | File replacement | Script execution |
| Uninstall process | File cleanup | Complete removal |

### 5. **External Integrations**
| Feature | Why Manual | What to Check |
|---------|------------|---------------|
| IDW authentication | Real OAuth flow | Login persistence |
| AI API calls | Real endpoints | Response quality |
| PDF export | Real PDF viewer | File validity |
| Browser extensions | Real browser | Clipboard access |
| Third-party app paste | App-specific | Format preservation |

### 6. **Edge Cases & Stress**
| Feature | Why Manual | What to Check |
|---------|------------|---------------|
| 1GB+ file drag | Real file handling | Performance |
| Unicode edge cases | Visual rendering | 𝕌𝕟𝕚𝕔𝕠𝕕𝕖 𝕋𝕖𝕤𝕥 |
| Rapid window switching | Real user behavior | State consistency |
| Network interruption | Physical disconnect | Recovery behavior |
| Low memory conditions | System state | Graceful degradation |

## Recommended Test Strategy

### 1. **Automated Test Suite** (80% coverage)
```javascript
// Run continuously
- Unit tests: Every commit (5 min)
- Integration tests: Every PR (15 min)  
- Performance tests: Nightly (30 min)
- Regression tests: Before release (20 min)
```

### 2. **Manual Test Suite** (20% coverage)
```markdown
- Visual inspection: Each UI change
- Platform testing: Each release
- Installation: Each build
- Real workflows: Weekly
- Edge cases: Before major release
```

### 3. **Hybrid Approach**
1. **Automate first**: Core logic, data flow, APIs
2. **Manual verification**: UI, UX, OS integration  
3. **Screenshot tests**: Capture UI states for comparison
4. **Synthetic monitoring**: Simulate user actions

## Test Automation ROI

### High ROI (Automate First)
- Clipboard parsing logic
- Space management operations  
- Settings persistence
- Export generation
- Search functionality
- Error handling

### Medium ROI (Automate Later)
- Window management
- IPC communication
- File operations
- Performance metrics

### Low ROI (Keep Manual)
- Visual design
- Drag & drop
- OS integration
- Installation flow
- Real-world workflows

## Tools Recommendation

### For Automated Testing
- **Spectron**: Electron app testing
- **Playwright**: Modern E2E testing
- **Jest**: Unit & integration tests
- **Sinon**: Mocking & stubs
- **Percy**: Visual regression testing

### For Manual Testing
- **TestRail**: Test case management
- **BrowserStack**: Cross-platform testing
- **Charles Proxy**: Network testing
- **Activity Monitor**: Performance testing 