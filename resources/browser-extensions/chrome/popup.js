/**
 * OneReach.ai Tab Share - Popup Script
 */

document.addEventListener('DOMContentLoaded', () => {
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const connectedView = document.getElementById('connectedView');
  const disconnectedView = document.getElementById('disconnectedView');
  const shareTabBtn = document.getElementById('shareTabBtn');
  const saveTokenBtn = document.getElementById('saveTokenBtn');
  const retryBtn = document.getElementById('retryBtn');
  const tokenInput = document.getElementById('tokenInput');
  const toast = document.getElementById('toast');

  // Check connection status
  checkStatus();

  // Event listeners
  shareTabBtn.addEventListener('click', shareCurrentTab);
  saveTokenBtn.addEventListener('click', saveToken);
  retryBtn.addEventListener('click', retryConnection);

  /**
   * Check connection status with background script
   */
  function checkStatus() {
    chrome.runtime.sendMessage({ type: 'get-status' }, (response) => {
      if (chrome.runtime.lastError) {
        showDisconnected('Extension error');
        return;
      }

      if (response && response.isConnected) {
        showConnected();
      } else if (response && response.hasToken) {
        showDisconnected('Connecting to app...');
        // Try to reconnect
        chrome.runtime.sendMessage({ type: 'reconnect' });
      } else {
        showDisconnected('Token required');
      }
    });
  }

  /**
   * Show connected state
   */
  function showConnected() {
    statusDot.classList.add('connected');
    statusText.textContent = 'Connected to OneReach.ai';
    connectedView.classList.remove('hidden');
    disconnectedView.classList.add('hidden');
  }

  /**
   * Show disconnected state
   */
  function showDisconnected(message) {
    statusDot.classList.remove('connected');
    statusText.textContent = message || 'Not connected';
    connectedView.classList.add('hidden');
    disconnectedView.classList.remove('hidden');
  }

  /**
   * Share current tab
   */
  function shareCurrentTab() {
    shareTabBtn.disabled = true;
    shareTabBtn.innerHTML = '<span>⏳</span> Sharing...';

    chrome.runtime.sendMessage({ type: 'share-current-tab' }, (response) => {
      shareTabBtn.disabled = false;
      shareTabBtn.innerHTML = '<span>📸</span> Share Current Tab';

      if (response && response.success) {
        showToast('Tab shared successfully!');
      } else {
        showToast('Failed to share tab', true);
      }
    });
  }

  /**
   * Save auth token
   */
  function saveToken() {
    const token = tokenInput.value.trim();
    
    if (!token) {
      showToast('Please enter a token', true);
      return;
    }

    if (token.length < 32) {
      showToast('Invalid token format', true);
      return;
    }

    saveTokenBtn.disabled = true;
    saveTokenBtn.textContent = 'Saving...';

    chrome.runtime.sendMessage({ type: 'set-token', token }, (response) => {
      saveTokenBtn.disabled = false;
      saveTokenBtn.textContent = 'Save Token';

      if (response && response.success) {
        showToast('Token saved!');
        tokenInput.value = '';
        
        // Wait a moment then check status
        setTimeout(checkStatus, 1000);
      } else {
        showToast('Failed to save token', true);
      }
    });
  }

  /**
   * Retry connection
   */
  function retryConnection() {
    retryBtn.disabled = true;
    retryBtn.innerHTML = '<span>⏳</span> Connecting...';

    chrome.runtime.sendMessage({ type: 'reconnect' }, () => {
      setTimeout(() => {
        retryBtn.disabled = false;
        retryBtn.innerHTML = '<span>🔄</span> Retry Connection';
        checkStatus();
      }, 2000);
    });
  }

  /**
   * Show toast notification
   */
  function showToast(message, isError = false) {
    toast.textContent = message;
    toast.classList.toggle('error', isError);
    toast.classList.add('show');

    setTimeout(() => {
      toast.classList.remove('show');
    }, 3000);
  }

  // Refresh status periodically while popup is open
  setInterval(checkStatus, 5000);
});



