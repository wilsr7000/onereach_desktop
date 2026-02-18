/**
 * Black Hole Button - Correct Implementation
 *
 * Dual-purpose button:
 * 1. HOVER (1.5s) -> Opens Black Hole widget for quick capture
 * 2. CLICK -> Opens Clipboard Viewer (Space Asset Manager)
 */

class BlackHoleButtonController {
  constructor(buttonElement) {
    this.button = buttonElement;
    this.hoverTimeout = null;
    this.blackHoleTimeout = null;
    this.isBlackHoleOpen = false;
    this.isClipboardViewerOpen = false;

    // Configuration
    this.HOVER_DELAY = 1500; // 1.5 seconds
    this.AUTO_CLOSE_DELAY = 5000; // 5 seconds

    this.init();
  }

  init() {
    if (!this.button) {
      console.error('[BlackHoleButton] Button element not found');
      return;
    }

    console.log('[BlackHoleButton] Initializing with dual functionality');

    // Remove any existing event listeners by cloning
    const newButton = this.button.cloneNode(true);
    this.button.parentNode.replaceChild(newButton, this.button);
    this.button = newButton;

    // Set up event handlers
    this.setupHoverBehavior();
    this.setupClickBehavior();
    this.setupDragBehavior();
    this.setupIPCListeners();

    console.log('[BlackHoleButton] Initialization complete');
  }

  setupHoverBehavior() {
    // Mouse enter - start hover timer
    this.button.addEventListener('mouseenter', () => {
      console.log('[BlackHoleButton] Mouse entered - starting 1.5s timer');

      // Start visual feedback
      this.button.classList.add('hovering');

      // Start timer for Black Hole widget
      this.hoverTimeout = setTimeout(() => {
        console.log('[BlackHoleButton] Hover timeout reached - opening Black Hole widget');
        this.openBlackHoleWidget();
      }, this.HOVER_DELAY);
    });

    // Mouse leave - cancel hover timer
    this.button.addEventListener('mouseleave', () => {
      if (this.hoverTimeout) {
        console.log('[BlackHoleButton] Mouse left - cancelling hover timer');
        clearTimeout(this.hoverTimeout);
        this.hoverTimeout = null;
      }

      // Remove visual feedback
      this.button.classList.remove('hovering');
    });
  }

  setupClickBehavior() {
    this.button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      console.log('[BlackHoleButton] Button clicked');

      // Cancel any pending hover action
      if (this.hoverTimeout) {
        clearTimeout(this.hoverTimeout);
        this.hoverTimeout = null;
        this.button.classList.remove('hovering');
      }

      // Cancel any auto-close timer
      if (this.blackHoleTimeout) {
        clearTimeout(this.blackHoleTimeout);
        this.blackHoleTimeout = null;
      }

      // Open the Clipboard Viewer (Space Asset Manager)
      this.openClipboardViewer();
    });
  }

  setupDragBehavior() {
    // Support drag-and-drop onto button
    this.button.addEventListener('dragenter', (e) => {
      e.preventDefault();
      console.log('[BlackHoleButton] Drag entered - opening Black Hole widget immediately');

      // Cancel hover timer if active
      if (this.hoverTimeout) {
        clearTimeout(this.hoverTimeout);
        this.hoverTimeout = null;
      }

      // Open Black Hole widget immediately for drag-and-drop
      this.openBlackHoleWidget();
    });

    this.button.addEventListener('dragover', (e) => {
      e.preventDefault(); // Allow drop
    });

    this.button.addEventListener('drop', (e) => {
      e.preventDefault();
      console.log('[BlackHoleButton] Drop on button - Black Hole widget should handle it');
      // The actual drop will be handled by the Black Hole widget
    });
  }

  setupIPCListeners() {
    if (!window.api || !window.api.receive) {
      console.warn('[BlackHoleButton] window.api.receive not available');
      return;
    }

    // Listen for Black Hole widget status
    window.api.receive('black-hole-opened', () => {
      console.log('[BlackHoleButton] Black Hole widget opened');
      this.isBlackHoleOpen = true;
      this.button.classList.add('black-hole-active');

      // Start auto-close timer
      this.blackHoleTimeout = setTimeout(() => {
        console.log('[BlackHoleButton] Auto-closing Black Hole widget');
        this.closeBlackHoleWidget();
      }, this.AUTO_CLOSE_DELAY);
    });

    window.api.receive('black-hole-closed', () => {
      console.log('[BlackHoleButton] Black Hole widget closed');
      this.isBlackHoleOpen = false;
      this.button.classList.remove('black-hole-active');

      // Clear auto-close timer
      if (this.blackHoleTimeout) {
        clearTimeout(this.blackHoleTimeout);
        this.blackHoleTimeout = null;
      }
    });

    // Listen for Black Hole activity (user interaction)
    window.api.receive('black-hole-active', () => {
      console.log('[BlackHoleButton] Black Hole widget is active - resetting auto-close');

      // Reset auto-close timer
      if (this.blackHoleTimeout) {
        clearTimeout(this.blackHoleTimeout);
        this.blackHoleTimeout = setTimeout(() => {
          console.log('[BlackHoleButton] Auto-closing Black Hole widget');
          this.closeBlackHoleWidget();
        }, this.AUTO_CLOSE_DELAY);
      }
    });

    // Listen for Clipboard Viewer status
    window.api.receive('clipboard-viewer-opened', () => {
      console.log('[BlackHoleButton] Clipboard Viewer opened');
      this.isClipboardViewerOpen = true;
      this.button.classList.add('viewer-active');
    });

    window.api.receive('clipboard-viewer-closed', () => {
      console.log('[BlackHoleButton] Clipboard Viewer closed');
      this.isClipboardViewerOpen = false;
      this.button.classList.remove('viewer-active');
    });
  }

  openBlackHoleWidget() {
    if (this.isBlackHoleOpen) {
      console.log('[BlackHoleButton] Black Hole widget already open');
      return;
    }

    if (!window.api || !window.api.send) {
      console.error('[BlackHoleButton] window.api.send not available');
      return;
    }

    console.log('[BlackHoleButton] Sending IPC: open-black-hole-widget');
    window.api.send('open-black-hole-widget', {
      source: 'hover',
      autoClose: true,
    });
  }

  closeBlackHoleWidget() {
    if (!this.isBlackHoleOpen) {
      return;
    }

    if (!window.api || !window.api.send) {
      console.error('[BlackHoleButton] window.api.send not available');
      return;
    }

    console.log('[BlackHoleButton] Sending IPC: close-black-hole-widget');
    window.api.send('close-black-hole-widget');
  }

  openClipboardViewer() {
    if (this.isClipboardViewerOpen) {
      console.log('[BlackHoleButton] Clipboard Viewer already open - focusing');
    }

    if (!window.api || !window.api.send) {
      console.error('[BlackHoleButton] window.api.send not available');
      return;
    }

    console.log('[BlackHoleButton] Sending IPC: open-clipboard-viewer');
    window.api.send('open-clipboard-viewer', {
      source: 'button-click',
    });

    // Visual feedback
    this.button.classList.add('clicked');
    setTimeout(() => {
      this.button.classList.remove('clicked');
    }, 200);
  }

  // Public method to clean up
  destroy() {
    if (this.hoverTimeout) {
      clearTimeout(this.hoverTimeout);
    }
    if (this.blackHoleTimeout) {
      clearTimeout(this.blackHoleTimeout);
    }
    this.button.classList.remove('hovering', 'black-hole-active', 'viewer-active', 'clicked');
  }
}

// Export for use in browser-renderer.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlackHoleButtonController;
} else {
  window.BlackHoleButtonController = BlackHoleButtonController;
}
