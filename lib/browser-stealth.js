'use strict';

let _session;
function getSession() {
  if (!_session) {
    try { _session = require('electron').session; } catch (_) {}
  }
  return _session;
}

const CHROME_VERSION = process.versions.chrome || '125.0.6422.176';
const CHROME_MAJOR = CHROME_VERSION.split('.')[0];

function getUserAgent() {
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;
}

function getSecChUa() {
  return `"Chromium";v="${CHROME_MAJOR}", "Not(A:Brand";v="24"`;
}

const INJECTION_SCRIPT = `
(function() {
  // --- webdriver ---
  delete window.navigator.__proto__.webdriver;
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });

  // --- user agent ---
  const ua = '${getUserAgent()}';
  Object.defineProperty(navigator, 'userAgent', { get: () => ua, configurable: true });
  Object.defineProperty(navigator, 'appVersion', {
    get: () => ua.replace('Mozilla/', ''),
    configurable: true,
  });

  // --- platform / vendor / device ---
  Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel', configurable: true });
  Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.', configurable: true });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });

  // --- languages ---
  Object.defineProperty(navigator, 'languages', {
    get: () => Object.freeze(['en-US', 'en']),
    configurable: true,
  });
  Object.defineProperty(navigator, 'language', { get: () => 'en-US', configurable: true });

  // --- plugins (Chrome ships PDF + Native Client) ---
  const fakePlugins = [
    { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chromium PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
  ];

  const mimeEntries = [
    { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable' },
  ];

  try {
    const pluginArray = Object.create(PluginArray.prototype);
    fakePlugins.forEach((p, i) => {
      const plug = Object.create(Plugin.prototype);
      Object.defineProperties(plug, {
        name: { value: p.name }, filename: { value: p.filename },
        description: { value: p.description }, length: { value: 0 },
      });
      Object.defineProperty(pluginArray, i, { value: plug, enumerable: true });
    });
    Object.defineProperty(pluginArray, 'length', { value: fakePlugins.length });
    Object.defineProperty(navigator, 'plugins', { get: () => pluginArray, configurable: true });

    const mimeArray = Object.create(MimeTypeArray.prototype);
    mimeEntries.forEach((m, i) => {
      const mime = Object.create(MimeType.prototype);
      Object.defineProperties(mime, {
        type: { value: m.type }, suffixes: { value: m.suffixes }, description: { value: m.description },
      });
      Object.defineProperty(mimeArray, i, { value: mime, enumerable: true });
      Object.defineProperty(mimeArray, m.type, { value: mime });
    });
    Object.defineProperty(mimeArray, 'length', { value: mimeEntries.length });
    Object.defineProperty(navigator, 'mimeTypes', { get: () => mimeArray, configurable: true });
  } catch (_) { /* best-effort */ }

  // --- permissions API ---
  if (navigator.permissions) {
    const origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = function(desc) {
      if (desc && desc.name === 'notifications') {
        return Promise.resolve({ state: 'prompt', onchange: null });
      }
      return origQuery(desc).catch(() => ({ state: 'prompt', onchange: null }));
    };
  }

  // --- connection / NetworkInformation ---
  if (!navigator.connection) {
    Object.defineProperty(navigator, 'connection', {
      get: () => ({
        effectiveType: '4g', downlink: 10, rtt: 50, saveData: false,
        addEventListener: () => {}, removeEventListener: () => {},
      }),
      configurable: true,
    });
  }

  // --- Notification ---
  if (typeof Notification !== 'undefined') {
    Object.defineProperty(Notification, 'permission', { get: () => 'default', configurable: true });
  }

  // --- chrome runtime ---
  if (!window.chrome) window.chrome = {};
  window.chrome.runtime = {
    id: undefined,
    connect: function() { return { onMessage: { addListener: function(){} }, postMessage: function(){} }; },
    sendMessage: function() {},
    onMessage: { addListener: function(){}, removeListener: function(){} },
    onConnect: { addListener: function(){}, removeListener: function(){} },
    getManifest: function() { return {}; },
  };
  window.chrome.loadTimes = function() {
    return {
      requestTime: Date.now() / 1000 - 0.5,
      startLoadTime: Date.now() / 1000 - 0.3,
      commitLoadTime: Date.now() / 1000 - 0.1,
      finishDocumentLoadTime: Date.now() / 1000,
      finishLoadTime: Date.now() / 1000,
      firstPaintTime: Date.now() / 1000 - 0.05,
      firstPaintAfterLoadTime: 0,
      navigationType: 'Other',
      wasFetchedViaSpdy: false,
      wasNpnNegotiated: true,
      npnNegotiatedProtocol: 'h2',
      wasAlternateProtocolAvailable: false,
      connectionInfo: 'h2',
    };
  };
  window.chrome.csi = function() {
    return { startE: Date.now(), onloadT: Date.now(), pageT: 300, tran: 15 };
  };

  // --- hide Electron process ---
  try { if (window.process && window.process.versions) delete window.process.versions.electron; } catch (_) {}
  try { if (window.process) { Object.defineProperty(window, 'process', { get: () => undefined, configurable: true }); } } catch (_) {}

  // --- window dimensions (non-zero in headless) ---
  if (window.outerWidth === 0 || window.outerHeight === 0) {
    Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth + 15, configurable: true });
    Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 85, configurable: true });
  }
  if (window.screenX === 0 && window.screenY === 0) {
    Object.defineProperty(window, 'screenX', { get: () => 22, configurable: true });
    Object.defineProperty(window, 'screenY', { get: () => 25, configurable: true });
  }

  // --- WebGL fingerprint ---
  try {
    const getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(p) {
      if (p === 37445) return 'Intel Inc.';
      if (p === 37446) return 'Intel Iris OpenGL Engine';
      return getParam.apply(this, arguments);
    };
    if (typeof WebGL2RenderingContext !== 'undefined') {
      const getParam2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(p) {
        if (p === 37445) return 'Intel Inc.';
        if (p === 37446) return 'Intel Iris OpenGL Engine';
        return getParam2.apply(this, arguments);
      };
    }
  } catch (_) {}

  // --- document.hasFocus ---
  document.hasFocus = function() { return true; };
})();
`;

function applyHeaders(sess) {
  const ua = getUserAgent();
  sess.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
    const headers = { ...details.requestHeaders };

    headers['User-Agent'] = ua;
    headers['Accept-Language'] = 'en-US,en;q=0.9';
    headers['Sec-Ch-Ua'] = getSecChUa();
    headers['Sec-Ch-Ua-Mobile'] = '?0';
    headers['Sec-Ch-Ua-Platform'] = '"macOS"';

    if (details.resourceType === 'mainFrame') {
      headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
      headers['Accept-Encoding'] = 'gzip, deflate, br';
      headers['Sec-Fetch-Dest'] = 'document';
      headers['Sec-Fetch-Mode'] = 'navigate';
      headers['Sec-Fetch-Site'] = 'none';
      headers['Sec-Fetch-User'] = '?1';
      headers['Upgrade-Insecure-Requests'] = '1';
    }

    delete headers['X-DevTools-Request-Id'];
    delete headers['X-Electron'];

    callback({ requestHeaders: headers });
  });
}

function apply(webContents) {
  const inject = () => {
    webContents.executeJavaScript(INJECTION_SCRIPT).catch(() => {});
  };

  webContents.on('did-finish-load', inject);
  webContents.on('did-navigate-in-page', inject);
  webContents.setUserAgent(getUserAgent());

  return () => {
    webContents.removeListener('did-finish-load', inject);
    webContents.removeListener('did-navigate-in-page', inject);
  };
}

function applyToSession(partitionName) {
  const electronSession = getSession();
  if (!electronSession) return null;
  const sess = electronSession.fromPartition(partitionName);
  applyHeaders(sess);
  return sess;
}

function buildEnhancedScript(profilePatches = {}) {
  let script = INJECTION_SCRIPT;
  const extras = [];

  if (profilePatches.canvasNoise) {
    extras.push(`
      (function() {
        const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL = function(type) {
          const ctx = this.getContext('2d');
          if (ctx) {
            const imageData = ctx.getImageData(0, 0, Math.min(this.width, 2), Math.min(this.height, 2));
            imageData.data[0] = (imageData.data[0] + Math.floor(Math.random() * 3)) & 0xFF;
            ctx.putImageData(imageData, 0, 0);
          }
          return origToDataURL.apply(this, arguments);
        };
        const origToBlob = HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toBlob = function(cb, type, quality) {
          const ctx = this.getContext('2d');
          if (ctx) {
            const imageData = ctx.getImageData(0, 0, Math.min(this.width, 2), Math.min(this.height, 2));
            imageData.data[0] = (imageData.data[0] + Math.floor(Math.random() * 3)) & 0xFF;
            ctx.putImageData(imageData, 0, 0);
          }
          return origToBlob.apply(this, arguments);
        };
      })();`);
  }

  if (profilePatches.audioNoise) {
    extras.push(`
      (function() {
        const origCreateOscillator = AudioContext.prototype.createOscillator;
        AudioContext.prototype.createOscillator = function() {
          const osc = origCreateOscillator.apply(this, arguments);
          const origConnect = osc.connect.bind(osc);
          osc.connect = function(dest) {
            if (dest instanceof AnalyserNode) {
              const gain = this.context.createGain();
              gain.gain.value = 1 + (Math.random() * 0.0001 - 0.00005);
              origConnect(gain);
              gain.connect(dest);
              return dest;
            }
            return origConnect(dest);
          };
          return osc;
        };
      })();`);
  }

  if (profilePatches.webrtcBlock) {
    extras.push(`
      (function() {
        if (window.RTCPeerConnection) {
          const origRTC = window.RTCPeerConnection;
          window.RTCPeerConnection = function(config) {
            if (config && config.iceServers) {
              config.iceServers = config.iceServers.filter(s =>
                !s.urls || !(typeof s.urls === 'string' ? s.urls : s.urls.join('')).includes('stun:')
              );
            }
            return new origRTC(config);
          };
          window.RTCPeerConnection.prototype = origRTC.prototype;
        }
      })();`);
  }

  if (profilePatches.fontEnum) {
    extras.push(`
      (function() {
        if (document.fonts && document.fonts.forEach) {
          const origForEach = document.fonts.forEach.bind(document.fonts);
          document.fonts.forEach = function(cb, thisArg) {
            let count = 0;
            origForEach(function(font) {
              if (count++ < 50) cb.call(thisArg, font);
            });
          };
        }
      })();`);
  }

  if (extras.length > 0) {
    script = script.trimEnd();
    if (script.endsWith('})();')) {
      script = script.slice(0, -5) + extras.join('\n') + '\n})();';
    } else {
      script += '\n' + extras.join('\n');
    }
  }

  return script;
}

function applyProfile(webContents, profilePatches) {
  const script = buildEnhancedScript(profilePatches);
  const inject = () => {
    webContents.executeJavaScript(script).catch(() => {});
  };

  webContents.on('did-finish-load', inject);
  webContents.on('did-navigate-in-page', inject);
  webContents.setUserAgent(getUserAgent());

  return () => {
    webContents.removeListener('did-finish-load', inject);
    webContents.removeListener('did-navigate-in-page', inject);
  };
}

module.exports = {
  apply, applyHeaders, applyToSession, applyProfile, buildEnhancedScript,
  getUserAgent, getSecChUa, CHROME_VERSION, CHROME_MAJOR,
};
