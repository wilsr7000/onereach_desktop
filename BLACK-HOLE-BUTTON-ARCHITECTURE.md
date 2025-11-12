# Black Hole Button Architecture & Functionality

## Purpose
The purple "Black Hole" button provides quick access to a floating clipboard/spaces manager widget that captures and manages clipboard content, files, and text snippets.

## Expected User Flow
1. **User Action**: Click the purple button (top-right of main window)
2. **Result**: A circular floating widget appears that can:
   - Capture clipboard content via drag-and-drop
   - Display recent clipboard history
   - Manage "spaces" (collections of clipboard items)
   - Stay on top of other windows (optional)
   - Expand to show more details

## Current Architecture (PROBLEMATIC)

### Component Flow:
```
[Button Click] → [browser-renderer.js] → [preload.js] → [main.js] → [clipboard-manager-v2-adapter.js] → [Black Hole Window]
```

### Files Involved:
1. **tabbed-browser.html** - Contains the button HTML
2. **browser-renderer.js** - Button event handlers (DUPLICATED & CONFLICTING CODE!)
3. **preload.js** - IPC bridge between renderer and main
4. **main.js** - IPC message receivers
5. **clipboard-manager-v2-adapter.js** - Creates the Black Hole window
6. **black-hole.html** - The widget UI
7. **black-hole.js** - Widget logic

## IDENTIFIED PROBLEMS

### 1. Multiple Conflicting Event Handlers
In `browser-renderer.js` we have:
- Lines 490-544: Simplified approach with `trigger-black-hole-shortcut`
- Lines 621-682: Original approach with `open-black-hole-widget`
- BOTH are trying to handle the same button!

### 2. IPC Message Confusion
- Button sends `trigger-black-hole-shortcut` (new)
- Button also sends `open-black-hole-widget` (old)
- Main process has handlers for BOTH

### 3. API Availability Issues
- `window.api` is available but messages aren't reaching main process
- Suggests the tabbed browser window has different context isolation

### 4. No Clear Separation of Concerns
- Button logic mixed with browser tab logic
- Clipboard management mixed with window management
- No clear module boundaries

## PROPOSED MODULAR ARCHITECTURE

### 1. **BlackHoleButton Module** (`black-hole-button.js`)
```javascript
// Dedicated module for button functionality only
export class BlackHoleButton {
  constructor(buttonElement) {
    this.button = buttonElement;
    this.isOpen = false;
  }
  
  init() {
    this.button.addEventListener('click', () => this.handleClick());
  }
  
  handleClick() {
    if (window.api?.send) {
      window.api.send('black-hole:toggle');
    }
  }
  
  updateState(isOpen) {
    this.isOpen = isOpen;
    this.button.classList.toggle('active', isOpen);
  }
}
```

### 2. **BlackHoleManager Module** (`black-hole-manager.js`)
```javascript
// Main process manager for Black Hole functionality
class BlackHoleManager {
  constructor() {
    this.window = null;
    this.clipboardManager = null;
  }
  
  init(clipboardManager) {
    this.clipboardManager = clipboardManager;
    this.setupIPC();
  }
  
  setupIPC() {
    ipcMain.on('black-hole:toggle', () => {
      this.toggle();
    });
  }
  
  toggle() {
    if (this.window) {
      this.close();
    } else {
      this.open();
    }
  }
  
  open(position) {
    // Create window logic
  }
  
  close() {
    // Close window logic
  }
}
```

### 3. **BlackHoleWidget Module** (`black-hole-widget.js`)
```javascript
// Renderer process for the widget itself
export class BlackHoleWidget {
  constructor() {
    this.spaces = [];
    this.currentSpace = null;
  }
  
  init() {
    this.setupUI();
    this.setupDragDrop();
    this.setupIPC();
  }
  
  // Separated concerns for UI, drag-drop, and IPC
}
```

## IMMEDIATE FIX STRATEGY

### Step 1: Clean Up Conflicting Code
Remove duplicate event handlers in `browser-renderer.js`

### Step 2: Single IPC Channel
Use only ONE IPC message: `black-hole:toggle`

### Step 3: Simplify Main Process Handler
```javascript
ipcMain.on('black-hole:toggle', () => {
  if (!global.blackHoleManager) {
    global.blackHoleManager = new BlackHoleManager();
  }
  global.blackHoleManager.toggle();
});
```

### Step 4: Test in Isolation
Create a standalone test button that ONLY tests Black Hole functionality

## DEBUGGING STEPS

1. **Check IPC Registration**:
   - Is `black-hole:toggle` in the preload whitelist?
   - Is the handler registered before button clicks?

2. **Verify Context Bridge**:
   - Does `window.api.send` actually send messages?
   - Add logging at EVERY step

3. **Test Keyboard Shortcut**:
   - If `Cmd+Shift+B` works, the issue is in button→IPC
   - If it doesn't work, the issue is in window creation

4. **Check Window Context**:
   - The tabbed browser might have different security context
   - Test button from a different window

## RECOMMENDED NEXT STEPS

1. **Isolate**: Create `black-hole-button-test.html` with ONLY the button
2. **Simplify**: Remove ALL duplicate handlers
3. **Log Everything**: Add console.log at every step
4. **Test Incrementally**: Test each layer separately
5. **Modularize**: Break into clear, testable modules

## SUCCESS CRITERIA

✅ Button click triggers IPC message  
✅ Main process receives message  
✅ Black Hole window opens  
✅ Widget is functional  
✅ Can be toggled open/closed  
✅ Keyboard shortcut works  
✅ No duplicate handlers  
✅ Clear error messages if something fails

