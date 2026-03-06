# Black Hole Button - CORRECT Behavior Specification

## The Button Has TWO Different Functions:

### 1. HOVER (No Click) - Black Hole Widget
- **Trigger**: Hover over button for 1.5 seconds WITHOUT clicking
- **Action**: Opens the floating Black Hole widget (circular window)
- **Purpose**: Quick paste/drop assets into current space
- **Auto-close**: After 5 seconds of inactivity
- **Visual**: Small floating circular window

### 2. CLICK - Space Asset Manager  
- **Trigger**: Click the purple button
- **Action**: Opens the Space Asset Manager modal
- **Purpose**: View and manage ALL collected assets across spaces
- **Visual**: Full modal/window with asset grid, search, filters

## Current Implementation Problems:

### What's Wrong:
1. Click is trying to open Black Hole widget (WRONG - should open Asset Manager)
2. Mouseover opens Black Hole immediately (WRONG - should wait 1.5 seconds)
3. No Space Asset Manager exists yet
4. Conflicting event handlers mixing both behaviors

### What Should Happen:

```javascript
// HOVER BEHAVIOR (1.5 second delay)
let hoverTimeout = null;

button.addEventListener('mouseenter', () => {
  hoverTimeout = setTimeout(() => {
    openBlackHoleWidget(); // Floating circular window
  }, 1500); // 1.5 seconds
});

button.addEventListener('mouseleave', () => {
  if (hoverTimeout) {
    clearTimeout(hoverTimeout);
    hoverTimeout = null;
  }
});

// CLICK BEHAVIOR
button.addEventListener('click', (e) => {
  e.preventDefault();
  
  // Cancel hover if active
  if (hoverTimeout) {
    clearTimeout(hoverTimeout);
    hoverTimeout = null;
  }
  
  openSpaceAssetManager(); // Modal window
});
```

## Two Different Windows:

### Black Hole Widget (hover)
- File: `black-hole.html` / `black-hole.js`
- Small, circular, floating
- Drag-and-drop zone
- Auto-hides after use
- For QUICK capture only

### Space Asset Manager (click)
- File: `space-manager.html` / `space-manager.js` (NEEDS TO BE CREATED)
- Full modal window
- Shows all spaces
- Shows all assets in each space
- Search, filter, organize capabilities
- Delete, rename, export functions

## Correct IPC Messages:

```javascript
// For hover (Black Hole widget)
window.api.send('black-hole:open-widget', { autoClose: true });

// For click (Space Manager)  
window.api.send('space-manager:open', { currentSpace: selectedSpace });
```

## Visual Feedback:

- **On Hover Start**: Button glows/pulses
- **After 1.5s**: Black Hole appears
- **On Click**: Button press animation, then modal opens
- **Active State**: Button shows different color when either is open

## Summary:

The purple button is a **dual-purpose control**:
1. **Hover = Quick Capture** (Black Hole widget)
2. **Click = Management** (Space Asset Manager)

This makes perfect sense from a UX perspective:
- Hover for quick, transient actions
- Click for deliberate management tasks


