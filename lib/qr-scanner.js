/**
 * QR Code Scanner for TOTP Setup
 * Reads QR codes from screen captures or image files
 * Extracts otpauth:// URIs for authenticator setup
 */

const jsQR = require('jsqr');
const { desktopCapturer, screen, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

class QRScanner {
  constructor() {
    log.info('app', 'Initialized');
  }

  /**
   * Scan QR code from the entire screen
   * User should have the QR code visible on screen before calling
   * @returns {Promise<string|null>} The decoded QR content (otpauth:// URI) or null
   */
  async scanFromScreen() {
    try {
      log.info('app', 'Starting screen capture for QR scan...');
      
      // Get screen dimensions
      const primaryDisplay = screen.getPrimaryDisplay();
      const { width, height } = primaryDisplay.workAreaSize;
      const scaleFactor = primaryDisplay.scaleFactor || 1;
      
      // Capture the screen
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.floor(width * scaleFactor),
          height: Math.floor(height * scaleFactor)
        }
      });
      
      if (!sources || sources.length === 0) {
        throw new Error('No screen sources available');
      }
      
      const primaryScreen = sources[0];
      const thumbnail = primaryScreen.thumbnail;
      
      if (!thumbnail || thumbnail.isEmpty()) {
        throw new Error('Screen capture returned empty image');
      }
      
      // Convert to bitmap for jsQR
      const { width: imgWidth, height: imgHeight } = thumbnail.getSize();
      const bitmap = thumbnail.toBitmap();
      
      log.info('app', 'Captured screen: x', { imgWidth: imgWidth, imgHeight: imgHeight });
      
      // Convert BGRA to RGBA (Electron uses BGRA, jsQR needs RGBA)
      const rgba = this._bgraToRgba(bitmap);
      
      // Scan for QR code
      const qrCode = jsQR(rgba, imgWidth, imgHeight);
      
      if (qrCode) {
        log.info('app', 'QR code found!');
        return qrCode.data;
      }
      
      log.info('app', 'No QR code found in screen capture');
      return null;
      
    } catch (error) {
      log.error('app', 'Screen scan error', { error: error.message });
      throw error;
    }
  }

  /**
   * Scan QR code from an image file
   * @param {string} imagePath - Path to image file (PNG, JPG, etc.)
   * @returns {Promise<string|null>} The decoded QR content or null
   */
  async scanFromFile(imagePath) {
    try {
      log.info('app', 'Scanning image file', { imagePath: imagePath });
      
      if (!fs.existsSync(imagePath)) {
        throw new Error(`Image file not found: ${imagePath}`);
      }
      
      const image = nativeImage.createFromPath(imagePath);
      
      if (image.isEmpty()) {
        throw new Error('Failed to load image file');
      }
      
      const { width, height } = image.getSize();
      const bitmap = image.toBitmap();
      
      // Convert BGRA to RGBA
      const rgba = this._bgraToRgba(bitmap);
      
      const qrCode = jsQR(rgba, width, height);
      
      if (qrCode) {
        log.info('app', 'QR code found in image!');
        return qrCode.data;
      }
      
      log.info('app', 'No QR code found in image');
      return null;
      
    } catch (error) {
      log.error('app', 'File scan error', { error: error.message });
      throw error;
    }
  }

  /**
   * Scan QR code from clipboard image
   * @returns {Promise<string|null>} The decoded QR content or null
   */
  async scanFromClipboard() {
    try {
      const { clipboard } = require('electron');
      const image = clipboard.readImage();
      
      if (image.isEmpty()) {
        log.info('app', 'No image in clipboard');
        return null;
      }
      
      const { width, height } = image.getSize();
      const bitmap = image.toBitmap();
      
      // Convert BGRA to RGBA
      const rgba = this._bgraToRgba(bitmap);
      
      const qrCode = jsQR(rgba, width, height);
      
      if (qrCode) {
        log.info('app', 'QR code found in clipboard!');
        return qrCode.data;
      }
      
      log.info('app', 'No QR code found in clipboard image');
      return null;
      
    } catch (error) {
      log.error('app', 'Clipboard scan error', { error: error.message });
      throw error;
    }
  }

  /**
   * Convert BGRA buffer to RGBA Uint8ClampedArray
   * Electron's toBitmap() returns BGRA, jsQR needs RGBA
   * @private
   */
  _bgraToRgba(bgraBuffer) {
    const rgba = new Uint8ClampedArray(bgraBuffer.length);
    
    for (let i = 0; i < bgraBuffer.length; i += 4) {
      rgba[i] = bgraBuffer[i + 2];     // R <- B
      rgba[i + 1] = bgraBuffer[i + 1]; // G <- G
      rgba[i + 2] = bgraBuffer[i];     // B <- R
      rgba[i + 3] = bgraBuffer[i + 3]; // A <- A
    }
    
    return rgba;
  }

  /**
   * Check if a string looks like an OTP auth URI
   * @param {string} data - String to check
   * @returns {boolean}
   */
  isOTPAuthURI(data) {
    return data && data.startsWith('otpauth://');
  }

  /**
   * Parse a manually entered secret (handle various formats)
   * Users might enter secrets with spaces, lowercase, etc.
   * @param {string} input - Raw user input
   * @returns {string} Cleaned Base32 secret
   */
  parseManualSecret(input) {
    if (!input) {
      throw new Error('No secret provided');
    }
    
    // Remove whitespace, convert to uppercase
    let secret = input.replace(/\s/g, '').toUpperCase();
    
    // Remove common prefixes users might accidentally include
    if (secret.startsWith('SECRET:')) {
      secret = secret.slice(7);
    }
    if (secret.startsWith('KEY:')) {
      secret = secret.slice(4);
    }
    
    // Validate Base32 characters
    const base32Regex = /^[A-Z2-7]+=*$/;
    if (!base32Regex.test(secret)) {
      throw new Error('Invalid secret format. Secret should only contain letters A-Z and numbers 2-7.');
    }
    
    return secret;
  }
}

// Singleton instance
let qrScanner = null;

function getQRScanner() {
  if (!qrScanner) {
    qrScanner = new QRScanner();
  }
  return qrScanner;
}

module.exports = { QRScanner, getQRScanner };
