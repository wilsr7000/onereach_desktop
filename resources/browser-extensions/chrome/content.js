/**
 * OneReach.ai Tab Share - Content Script
 * 
 * Injected into pages to extract readable text content.
 * Can also be used for highlighting and selection features.
 */

(function() {
  'use strict';

  /**
   * Extract readable text from the page
   */
  function extractPageText() {
    // Try to find the main content container
    const article = document.querySelector('article');
    const main = document.querySelector('main');
    const contentDiv = document.querySelector('[role="main"]');
    const body = document.body;
    
    const container = article || main || contentDiv || body;
    
    // Clone to avoid modifying the actual page
    const clone = container.cloneNode(true);
    
    // Remove non-content elements
    const removeSelectors = [
      'script',
      'style',
      'noscript',
      'nav',
      'footer',
      'aside',
      'header',
      'iframe',
      '.ad',
      '.ads',
      '.advertisement',
      '.sidebar',
      '.navigation',
      '.menu',
      '.comments',
      '.social-share',
      '[role="navigation"]',
      '[role="banner"]',
      '[role="complementary"]',
      '[aria-hidden="true"]'
    ];
    
    removeSelectors.forEach(selector => {
      try {
        clone.querySelectorAll(selector).forEach(el => el.remove());
      } catch (e) {
        // Ignore invalid selectors
      }
    });
    
    // Get text content
    let text = clone.textContent || clone.innerText || '';
    
    // Clean up whitespace
    text = text
      .replace(/\t/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/ {2,}/g, ' ')
      .trim();
    
    // Limit length to avoid huge payloads
    const MAX_LENGTH = 100000;
    if (text.length > MAX_LENGTH) {
      text = text.substring(0, MAX_LENGTH) + '\n\n[Content truncated...]';
    }
    
    return text;
  }

  /**
   * Extract page metadata
   */
  function extractMetadata() {
    const metadata = {
      title: document.title,
      url: window.location.href,
      description: '',
      author: '',
      publishedDate: '',
      siteName: ''
    };

    // Get meta tags
    const getMeta = (name) => {
      const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"], meta[property="og:${name}"]`);
      return el ? el.getAttribute('content') : '';
    };

    metadata.description = getMeta('description') || getMeta('og:description');
    metadata.author = getMeta('author') || getMeta('article:author');
    metadata.publishedDate = getMeta('article:published_time') || getMeta('date');
    metadata.siteName = getMeta('og:site_name');

    return metadata;
  }

  /**
   * Get the current selection
   */
  function getSelection() {
    const selection = window.getSelection();
    if (selection && selection.toString().trim()) {
      return {
        text: selection.toString(),
        html: getSelectionHtml()
      };
    }
    return null;
  }

  /**
   * Get selection as HTML
   */
  function getSelectionHtml() {
    const selection = window.getSelection();
    if (!selection.rangeCount) return '';
    
    const container = document.createElement('div');
    for (let i = 0; i < selection.rangeCount; i++) {
      container.appendChild(selection.getRangeAt(i).cloneContents());
    }
    return container.innerHTML;
  }

  /**
   * Listen for messages from background script
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
      case 'extractText':
        sendResponse({
          text: extractPageText(),
          metadata: extractMetadata()
        });
        break;

      case 'getSelection':
        sendResponse(getSelection());
        break;

      case 'getMetadata':
        sendResponse(extractMetadata());
        break;

      default:
        sendResponse({ error: 'Unknown action' });
    }
    
    return true;
  });

  // Expose functions for direct injection via executeScript
  window.__onereach = {
    extractPageText,
    extractMetadata,
    getSelection
  };

  console.log('[OneReach] Content script loaded');
})();




