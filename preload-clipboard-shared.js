/**
 * Shared Clipboard preload module
 * Consolidates clipboard API variations across preload scripts.
 *
 * Used by: preload-spaces.js, preload-orb.js
 * Pattern: Same as preload-hud-api.js and preload-orb-control.js
 */

const { clipboard } = require('electron');

/**
 * Returns clipboard API methods.
 * @param {object} [options]
 * @param {boolean} [options.includeHTML=false] - Include readHTML method
 * @param {boolean} [options.includeHasText=false] - Include hasText method
 */
function getClipboardMethods(options = {}) {
  const methods = {
    readText: () => clipboard.readText(),
    writeText: (text) => clipboard.writeText(text),
  };

  if (options.includeHTML) {
    methods.readHTML = () => clipboard.readHTML();
  }

  if (options.includeHasText) {
    methods.hasText = () => clipboard.readText().length > 0;
  }

  return methods;
}

module.exports = { getClipboardMethods };
