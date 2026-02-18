/**
 * Browser File Input Enhancer
 *
 * Intercepts file input clicks to show "Files or Spaces?" dialog
 * Allows users to choose between local files or Spaces content
 */

(function () {
  'use strict';

  console.log('[Spaces Upload] File input enhancer loaded');

  // Check if feature is disabled
  if (window.__SPACES_UPLOAD_DISABLED__) {
    console.log('[Spaces Upload] Feature disabled, not enhancing inputs');
    return;
  }

  const DIALOG_CSS = `
    .spaces-upload-dialog {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 999999;
      animation: fadeIn 0.2s ease;
    }
    
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    
    .spaces-upload-dialog-content {
      background: linear-gradient(135deg, #1e1e1e 0%, #2d2d2d 100%);
      border-radius: 16px;
      padding: 32px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
      max-width: 450px;
      width: 90%;
      animation: slideUp 0.3s ease;
    }
    
    @keyframes slideUp {
      from { transform: translateY(20px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
    
    .spaces-upload-dialog h2 {
      margin: 0 0 12px 0;
      color: white;
      font-size: 24px;
      font-weight: 600;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    
    .spaces-upload-dialog p {
      margin: 0 0 24px 0;
      color: #aaa;
      font-size: 14px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    
    .spaces-upload-choices {
      display: flex;
      gap: 16px;
      margin-bottom: 16px;
    }
    
    .spaces-upload-choice {
      flex: 1;
      padding: 24px 20px;
      background: rgba(255, 255, 255, 0.05);
      border: 2px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      cursor: pointer;
      transition: all 0.2s ease;
      text-align: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    
    .spaces-upload-choice:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.2);
      transform: translateY(-2px);
    }
    
    .spaces-upload-choice-icon {
      font-size: 48px;
      margin-bottom: 12px;
    }
    
    .spaces-upload-choice-label {
      font-size: 16px;
      font-weight: 600;
      color: white;
      margin-bottom: 4px;
    }
    
    .spaces-upload-choice-desc {
      font-size: 12px;
      color: #888;
    }
    
    .spaces-upload-choice.spaces {
      border-color: rgba(106, 27, 154, 0.5);
    }
    
    .spaces-upload-choice.spaces:hover {
      background: rgba(106, 27, 154, 0.2);
      border-color: #6a1b9a;
    }
    
    .spaces-upload-cancel {
      width: 100%;
      padding: 12px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      color: white;
      font-size: 14px;
      cursor: pointer;
      transition: all 0.2s ease;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    
    .spaces-upload-cancel:hover {
      background: rgba(255, 255, 255, 0.1);
    }
  `;

  // Inject CSS
  const style = document.createElement('style');
  style.textContent = DIALOG_CSS;
  document.head.appendChild(style);

  // Track enhanced inputs
  const enhancedInputs = new WeakSet();

  /**
   * Show choice dialog: Files or Spaces?
   * Uses programmatic DOM construction to bypass Trusted Types restrictions
   */
  function showChoiceDialog(_input) {
    return new Promise((resolve) => {
      // Create dialog container
      const dialog = document.createElement('div');
      dialog.className = 'spaces-upload-dialog';

      // Create content container
      const content = document.createElement('div');
      content.className = 'spaces-upload-dialog-content';

      // Create title
      const title = document.createElement('h2');
      title.textContent = '📤 Choose Upload Source';
      content.appendChild(title);

      // Create description
      const desc = document.createElement('p');
      desc.textContent = 'Where would you like to upload from?';
      content.appendChild(desc);

      // Create choices container
      const choicesContainer = document.createElement('div');
      choicesContainer.className = 'spaces-upload-choices';

      // Create Files choice
      const filesChoice = document.createElement('div');
      filesChoice.className = 'spaces-upload-choice files';
      filesChoice.setAttribute('data-choice', 'files');

      const filesIcon = document.createElement('div');
      filesIcon.className = 'spaces-upload-choice-icon';
      filesIcon.textContent = '📁';
      filesChoice.appendChild(filesIcon);

      const filesLabel = document.createElement('div');
      filesLabel.className = 'spaces-upload-choice-label';
      filesLabel.textContent = 'Files';
      filesChoice.appendChild(filesLabel);

      const filesDesc = document.createElement('div');
      filesDesc.className = 'spaces-upload-choice-desc';
      filesDesc.textContent = 'Browse local files';
      filesChoice.appendChild(filesDesc);

      choicesContainer.appendChild(filesChoice);

      // Create Spaces choice
      const spacesChoice = document.createElement('div');
      spacesChoice.className = 'spaces-upload-choice spaces';
      spacesChoice.setAttribute('data-choice', 'spaces');

      const spacesIcon = document.createElement('div');
      spacesIcon.className = 'spaces-upload-choice-icon';
      spacesIcon.textContent = '📦';
      spacesChoice.appendChild(spacesIcon);

      const spacesLabel = document.createElement('div');
      spacesLabel.className = 'spaces-upload-choice-label';
      spacesLabel.textContent = 'Spaces';
      spacesChoice.appendChild(spacesLabel);

      const spacesDesc = document.createElement('div');
      spacesDesc.className = 'spaces-upload-choice-desc';
      spacesDesc.textContent = 'Choose from Spaces';
      spacesChoice.appendChild(spacesDesc);

      choicesContainer.appendChild(spacesChoice);
      content.appendChild(choicesContainer);

      // Create cancel button
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'spaces-upload-cancel';
      cancelBtn.textContent = 'Cancel';
      content.appendChild(cancelBtn);

      // Assemble dialog
      dialog.appendChild(content);
      document.body.appendChild(dialog);

      // Handle choices
      filesChoice.onclick = () => {
        document.body.removeChild(dialog);
        resolve('files');
      };

      spacesChoice.onclick = () => {
        document.body.removeChild(dialog);
        resolve('spaces');
      };

      cancelBtn.onclick = () => {
        document.body.removeChild(dialog);
        resolve(null);
      };

      // Click outside to cancel
      dialog.onclick = (e) => {
        if (e.target === dialog) {
          document.body.removeChild(dialog);
          resolve(null);
        }
      };

      // ESC to cancel
      const escHandler = (e) => {
        if (e.key === 'Escape') {
          if (document.body.contains(dialog)) {
            document.body.removeChild(dialog);
          }
          document.removeEventListener('keydown', escHandler);
          resolve(null);
        }
      };
      document.addEventListener('keydown', escHandler);
    });
  }

  /**
   * Handle Spaces selection
   */
  async function handleSpacesUpload(input) {
    // Check if IPC is available
    if (!window.electronAPI || !window.electronAPI.openSpacesPicker) {
      console.error('[Spaces Upload] electronAPI not available');
      alert('Spaces upload is not available in this context');
      return;
    }

    try {
      // Call IPC to open Spaces picker
      const fileDataList = await window.electronAPI.openSpacesPicker();

      if (!fileDataList || fileDataList.length === 0) {
        console.log('[Spaces Upload] No files selected');
        return;
      }

      console.log('[Spaces Upload] Files selected:', fileDataList.length);

      // Create DataTransfer to hold files
      const dataTransfer = new DataTransfer();

      // Convert base64 data to File objects
      for (const fileData of fileDataList) {
        try {
          // Convert base64 to blob
          const binaryString = atob(fileData.data);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          const blob = new Blob([bytes], { type: fileData.type });

          // Create File object
          const file = new File([blob], fileData.name, {
            type: fileData.type,
          });

          dataTransfer.items.add(file);
          console.log('[Spaces Upload] Added file:', fileData.name, blob.size, 'bytes');
        } catch (err) {
          console.error('[Spaces Upload] Error loading file:', fileData.name, err);
        }
      }

      if (dataTransfer.files.length === 0) {
        console.warn('[Spaces Upload] No files could be loaded');
        return;
      }

      // Set files on input
      input.files = dataTransfer.files;

      // Trigger change event
      const changeEvent = new Event('change', { bubbles: true });
      input.dispatchEvent(changeEvent);

      // Also trigger input event (some sites listen to this)
      const inputEvent = new Event('input', { bubbles: true });
      input.dispatchEvent(inputEvent);

      console.log('[Spaces Upload] Files injected successfully:', dataTransfer.files.length);
    } catch (err) {
      console.error('[Spaces Upload] Error:', err);
      alert('Error selecting files from Spaces: ' + err.message);
    }
  }

  /**
   * Enhance a single file input
   */
  function enhanceFileInput(input) {
    if (enhancedInputs.has(input)) return;
    if (!input.parentElement) return;

    // Check if feature is enabled (via injected config)
    if (window.__SPACES_UPLOAD_DISABLED__) return;

    enhancedInputs.add(input);

    // Store the original click method
    const originalClick = input.click.bind(input);

    // Override the click method to intercept programmatic clicks
    input.click = async function () {
      console.log('[Spaces Upload] File input click intercepted (programmatic)');

      const choice = await showChoiceDialog(input);

      if (choice === 'files') {
        // Let native file picker open by calling original click
        originalClick();
      } else if (choice === 'spaces') {
        await handleSpacesUpload(input);
      }
      // If choice is null, user cancelled - do nothing
    };

    console.log('[Spaces Upload] Enhanced file input with click override');
  }

  /**
   * Scan for file inputs and enhance them
   */
  function scanForFileInputs() {
    const inputs = document.querySelectorAll('input[type="file"]');
    inputs.forEach(enhanceFileInput);
  }

  // Initial scan
  scanForFileInputs();

  // Watch for new inputs (many sites dynamically add file inputs)
  const observer = new MutationObserver(() => {
    scanForFileInputs();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  console.log('[Spaces Upload] Watching for file inputs');
})();
