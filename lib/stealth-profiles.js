'use strict';

const PROFILES = {
  cloudflare: {
    id: 'cloudflare',
    domains: ['*.cloudflare.com'],
    detect: (headers) => !!(headers['cf-ray'] || headers['server'] === 'cloudflare'),
    patches: { canvasNoise: true, audioNoise: true, webrtcBlock: true, fontEnum: true },
    timing: { minActionDelay: 800, preActionDelay: 200 },
    preferBackend: 'chrome',
  },
  google: {
    id: 'google',
    domains: ['*.google.com', '*.google.co.*', '*.youtube.com', '*.gmail.com', '*.googleapis.com'],
    patches: { chromeExtensions: true, serviceWorkerScope: true },
    timing: { minActionDelay: 400 },
  },
  microsoft: {
    id: 'microsoft',
    domains: ['*.microsoft.com', '*.live.com', '*.office.com', '*.microsoftonline.com'],
    patches: { chromeExtensions: true },
    timing: { minActionDelay: 300 },
  },
  recaptcha: {
    id: 'recaptcha',
    detect: (_headers, html) => {
      if (!html) return false;
      const lower = html.toLowerCase();
      return lower.includes('recaptcha') || lower.includes('hcaptcha') || lower.includes('h-captcha') || lower.includes('turnstile');
    },
    patches: { canvasNoise: true, audioNoise: true },
    preferBackend: 'chrome',
    timing: { preActionDelay: 500 },
  },
  datadome: {
    id: 'datadome',
    detect: (headers) => !!(headers['x-datadome'] || headers['server'] === 'DataDome'),
    patches: { canvasNoise: true, audioNoise: true, webrtcBlock: true, fontEnum: true },
    preferBackend: 'chrome',
    timing: { minActionDelay: 1000, preActionDelay: 500 },
  },
  perimeterx: {
    id: 'perimeterx',
    detect: (headers, html) => {
      if (headers['x-px']) return true;
      if (!html) return false;
      return html.includes('_pxAppId') || html.includes('perimeterx');
    },
    patches: { canvasNoise: true, audioNoise: true, webrtcBlock: true },
    preferBackend: 'chrome',
    timing: { minActionDelay: 800 },
  },
  default: {
    id: 'default',
    domains: ['*'],
    patches: { standard: true },
    timing: { minActionDelay: 200, preActionDelay: 0 },
  },
};

function _domainMatches(pattern, domain) {
  if (pattern === '*') return true;
  const escaped = pattern.replace(/\./g, '\\.').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(domain);
}

function getProfileForDomain(domain) {
  for (const [key, profile] of Object.entries(PROFILES)) {
    if (key === 'default') continue;
    if (!profile.domains) continue;
    for (const pattern of profile.domains) {
      if (_domainMatches(pattern, domain)) return { ...PROFILES.default, ...profile };
    }
  }
  return { ...PROFILES.default };
}

function detectProfile(headers = {}, html = '') {
  for (const [key, profile] of Object.entries(PROFILES)) {
    if (key === 'default') continue;
    if (typeof profile.detect === 'function' && profile.detect(headers, html)) {
      return { ...PROFILES.default, ...profile };
    }
  }
  return null;
}

function getProfile(id) {
  return PROFILES[id] || null;
}

function listProfiles() {
  return Object.keys(PROFILES);
}

function shouldPreferChrome(domain, headers, html) {
  const domainProfile = getProfileForDomain(domain);
  if (domainProfile.preferBackend === 'chrome') return true;

  const detected = detectProfile(headers, html);
  if (detected && detected.preferBackend === 'chrome') return true;

  return false;
}

module.exports = {
  PROFILES,
  getProfileForDomain,
  detectProfile,
  getProfile,
  listProfiles,
  shouldPreferChrome,
};
