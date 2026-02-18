/**
 * Black Hole Button Module
 * Clean, isolated implementation with no conflicts
 */

class BlackHoleButtonModule {
  constructor() {
    this.button = null;
    this.statusElement = null;
    this.isOpen = false;
    this.initialized = false;
  }

  init() {
    this.log('Initializing Black Hole Button Module...', 'info');

    // Get elements
    this.button = document.getElementById('black-hole-button');
    this.statusElement = document.getElementById('status');

    if (!this.button) {
      this.log('ERROR: Button element not found!', 'error');
      return false;
    }

    // Check API availability
    this.checkAPI();

    // Setup SINGLE click handler
    this.setupClickHandler();

    // Listen for status updates from main process
    this.setupIPCListeners();

    this.initialized = true;
    this.log('Black Hole Button Module initialized successfully', 'success');
    return true;
  }

  checkAPI() {
    this.log('Checking API availability...', 'info');

    if (typeof window.api === 'undefined') {
      this.log('window.api is undefined', 'error');
      return false;
    }

    if (typeof window.api === 'object') {
      this.log('window.api is an object', 'success');

      if (typeof window.api.send === 'function') {
        this.log('window.api.send is a function', 'success');
      } else {
        this.log('window.api.send is NOT a function', 'error');
      }

      if (typeof window.api.receive === 'function') {
        this.log('window.api.receive is a function', 'success');
      } else {
        this.log('window.api.receive is NOT a function', 'warning');
      }
    }

    return true;
  }

  setupClickHandler() {
    this.log('Setting up click handler...', 'info');

    // Remove any existing handlers
    const newButton = this.button.cloneNode(true);
    this.button.parentNode.replaceChild(newButton, this.button);
    this.button = newButton;

    // Add SINGLE click handler
    this.button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleClick();
    });

    this.log('Click handler attached', 'success');
  }

  handleClick() {
    const timestamp = new Date().toLocaleTimeString();
    this.log(`[${timestamp}] Button clicked!`, 'info');

    if (!window.api || !window.api.send) {
      this.log('ERROR: window.api.send not available!', 'error');
      this.showFallbackDialog();
      return;
    }

    try {
      // Use a SINGLE, CLEAR IPC message
      this.log('Sending IPC message: black-hole:open', 'info');
      window.api.send('black-hole:open', {
        source: 'button',
        timestamp: Date.now(),
      });
      this.log('IPC message sent successfully', 'success');

      // Visual feedback
      this.button.classList.add('active');
      setTimeout(() => {
        this.button.classList.remove('active');
      }, 500);
    } catch (error) {
      this.log(`ERROR sending IPC: ${error.message}`, 'error');
      console.error('Full error:', error);
    }
  }

  setupIPCListeners() {
    if (!window.api || !window.api.receive) {
      this.log('window.api.receive not available, skipping IPC listeners', 'warning');
      return;
    }

    // Listen for Black Hole status updates
    window.api.receive('black-hole:opened', () => {
      this.isOpen = true;
      this.button.classList.add('active');
      this.log('Black Hole opened', 'success');
    });

    window.api.receive('black-hole:closed', () => {
      this.isOpen = false;
      this.button.classList.remove('active');
      this.log('Black Hole closed', 'info');
    });

    this.log('IPC listeners set up', 'success');
  }

  showFallbackDialog() {
    const message = `
Black Hole Widget cannot be opened.

Possible issues:
1. API bridge not available
2. App needs restart
3. Security context issue

Try:
- Restarting the app
- Using Cmd+Shift+B shortcut
        `.trim();

    alert(message);
  }

  log(message, type = 'info') {
    // Console log
    const prefix = type.toUpperCase();
    console.log(`[BLACK HOLE MODULE] ${prefix}: ${message}`);

    // Visual log
    if (this.statusElement) {
      const line = document.createElement('div');
      line.className = `status-line ${type}`;
      line.textContent = message;
      this.statusElement.appendChild(line);

      // Auto-scroll to bottom
      this.statusElement.scrollTop = this.statusElement.scrollHeight;
    }
  }
}

// Global functions for testing
function _clearStatus() {
  const statusElement = document.getElementById('status');
  if (statusElement) {
    statusElement.innerHTML = '<div class="status-line info">Log cleared</div>';
  }
}

function _testAPI() {
  const module = window.blackHoleModule;
  if (module) {
    module.log('=== API Test ===', 'info');
    module.checkAPI();

    // Deep inspection
    module.log('Checking window properties...', 'info');
    module.log(`window.api type: ${typeof window.api}`, 'info');
    module.log(`window.electron type: ${typeof window.electron}`, 'info');
    module.log(`window.clipboard type: ${typeof window.clipboard}`, 'info');

    if (window.api) {
      module.log('window.api properties:', 'info');
      for (let prop in window.api) {
        module.log(`  - ${prop}: ${typeof window.api[prop]}`, 'info');
      }
    }
  }
}

function _testIPCDirect() {
  const module = window.blackHoleModule;
  if (module) {
    module.log('=== Direct IPC Test ===', 'info');

    if (window.api && window.api.send) {
      try {
        module.log('Attempting to send test IPC message...', 'info');
        window.api.send('test:ping', { timestamp: Date.now() });
        module.log('Test message sent', 'success');
      } catch (error) {
        module.log(`Error: ${error.message}`, 'error');
      }
    } else {
      module.log('window.api.send not available', 'error');
    }
  }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  console.log('[BLACK HOLE MODULE] DOM Ready, initializing...');

  // Create and initialize module
  const module = new BlackHoleButtonModule();
  window.blackHoleModule = module; // Make available globally for testing

  const success = module.init();
  if (!success) {
    console.error('[BLACK HOLE MODULE] Initialization failed!');
  }
});

// Also log immediately
console.log('[BLACK HOLE MODULE] Script loaded');
console.log('[BLACK HOLE MODULE] window.api:', window.api);
console.log('[BLACK HOLE MODULE] window.electron:', window.electron);
