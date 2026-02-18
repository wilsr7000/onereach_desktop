const { BrowserWindow } = require('electron');
const path = require('path');

// Lazy-load dialog to avoid issues when required before app is ready
let electronDialog = null;
function getElectronDialog() {
  if (!electronDialog) {
    electronDialog = require('electron').dialog;
  }
  return electronDialog;
}

/**
 * Wrapped Dialog Module
 *
 * Wraps Electron's dialog.showOpenDialog() to provide "Choose from Spaces" option
 * Maintains all original dialog functionality while adding Spaces integration
 */

class WrappedDialog {
  constructor() {
    // Methods are proxied on-demand, no initialization needed
  }

  // Proxy any method calls to the real dialog
  _getDialog() {
    return getElectronDialog();
  }

  /**
   * Wrapped showOpenDialog - intercepts and adds "Choose from Spaces" option
   * Maintains both Electron signatures:
   * - showOpenDialog([browserWindow, ]options)
   *
   * @param {BrowserWindow|Object} windowOrOptions - BrowserWindow or options object
   * @param {Object} maybeOptions - Options object if first param was BrowserWindow
   * @returns {Promise<{canceled: boolean, filePaths: string[], bookmarks?: string[]}>}
   */
  async showOpenDialog(windowOrOptions, maybeOptions) {
    const dialog = this._getDialog();

    // Parse arguments (Electron supports both signatures)
    let browserWindow, options;
    if (maybeOptions) {
      browserWindow = windowOrOptions;
      options = maybeOptions;
    } else if (windowOrOptions instanceof BrowserWindow) {
      browserWindow = windowOrOptions;
      options = {};
    } else {
      browserWindow = BrowserWindow.getFocusedWindow();
      options = windowOrOptions || {};
    }

    // Check if Spaces integration is enabled in settings
    const settingsManager = global.settingsManager;
    const spacesEnabled = settingsManager?.getSpacesUploadEnabled() !== false;

    if (!spacesEnabled) {
      // Feature disabled - use original Electron dialog
      console.log('[Wrapped Dialog] Spaces integration disabled, using native dialog');
      return await dialog.showOpenDialog(browserWindow, options);
    }

    // Show our custom dialog with instructions
    const choice = await dialog.showMessageBox(browserWindow, {
      type: 'question',
      buttons: ['Choose from Computer', 'Choose from Spaces', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'Select Files',
      message: 'Where would you like to choose files from?',
      detail:
        'Select files from your computer or choose items from your Spaces.\n\nTo disable this dialog: Settings → Spaces Upload Integration',
      icon: path.join(__dirname, 'assets/tray-icon.png'),
    });

    if (choice.response === 0) {
      // Choose from Computer - use original Electron dialog
      console.log('[Wrapped Dialog] User chose: Computer');
      return await dialog.showOpenDialog(browserWindow, options);
    } else if (choice.response === 1) {
      // Choose from Spaces
      console.log('[Wrapped Dialog] User chose: Spaces');
      const { showSpacesPicker } = require('./spaces-upload-handler');
      const selectedFiles = await showSpacesPicker(browserWindow);

      if (!selectedFiles || selectedFiles.length === 0) {
        console.log('[Wrapped Dialog] No files selected from Spaces');
        return { canceled: true, filePaths: [] };
      }

      console.log('[Wrapped Dialog] Selected from Spaces:', selectedFiles.length, 'files');
      return {
        canceled: false,
        filePaths: selectedFiles,
      };
    } else {
      // User cancelled
      console.log('[Wrapped Dialog] User cancelled');
      return { canceled: true, filePaths: [] };
    }
  }

  /**
   * Original methods pass through directly
   */
  async showSaveDialog(windowOrOptions, maybeOptions) {
    return await this._getDialog().showSaveDialog(windowOrOptions, maybeOptions);
  }

  async showMessageBox(windowOrOptions, maybeOptions) {
    return await this._getDialog().showMessageBox(windowOrOptions, maybeOptions);
  }

  showErrorBox(title, content) {
    return this._getDialog().showErrorBox(title, content);
  }

  async showCertificateTrustDialog(windowOrOptions, maybeOptions) {
    return await this._getDialog().showCertificateTrustDialog(windowOrOptions, maybeOptions);
  }
}

// Export singleton instance
module.exports = new WrappedDialog();
