/**
 * Web Monitors Feature Tests
 *
 * Run with: node test/web-monitors.test.js
 *
 * Tests the following functionality:
 * 1. System space creation (Web Monitors)
 * 2. URL detection and extraction
 * 3. Noise filtering (heuristics, no AI)
 * 4. Auto-pause for dynamic sites
 * 5. Error categorization
 */

const assert = require('assert');

// Test results tracker
const results = {
  passed: 0,
  failed: 0,
  tests: [],
};

function test(name, fn) {
  try {
    fn();
    results.passed++;
    results.tests.push({ name, status: 'PASS' });
    console.log(`  [PASS] ${name}`);
  } catch (error) {
    results.failed++;
    results.tests.push({ name, status: 'FAIL', error: error.message });
    console.log(`  [FAIL] ${name}`);
    console.log(`         ${error.message}`);
  }
}

// ========================================
// URL Extraction Tests
// ========================================
console.log('\n--- URL Extraction Tests ---');

// Mock the extractURL function (same logic as in clipboard-manager-v2-adapter.js)
function extractURL(content) {
  if (!content || typeof content !== 'string') return null;

  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
  const matches = content.match(urlRegex);

  if (!matches || matches.length === 0) return null;

  let url = matches[0];
  url = url.replace(/[.,;:!?)]+$/, '');

  try {
    new URL(url);
    return url;
  } catch (_e) {
    return null;
  }
}

test('extracts simple HTTPS URL', () => {
  const result = extractURL('Check out https://example.com');
  assert.strictEqual(result, 'https://example.com');
});

test('extracts URL with path', () => {
  const result = extractURL('Visit https://example.com/page/123');
  assert.strictEqual(result, 'https://example.com/page/123');
});

test('extracts URL with query params', () => {
  const result = extractURL('Link: https://example.com/search?q=test&page=1');
  assert.strictEqual(result, 'https://example.com/search?q=test&page=1');
});

test('strips trailing punctuation', () => {
  const result = extractURL('See https://example.com.');
  assert.strictEqual(result, 'https://example.com');
});

test('returns null for no URL', () => {
  const result = extractURL('Just some text without a link');
  assert.strictEqual(result, null);
});

test('returns null for invalid URL', () => {
  const result = extractURL('http://');
  assert.strictEqual(result, null);
});

test('extracts first URL when multiple present', () => {
  const result = extractURL('First https://one.com then https://two.com');
  assert.strictEqual(result, 'https://one.com');
});

// ========================================
// Noise Pattern Tests
// ========================================
console.log('\n--- Noise Pattern Tests ---');

// Mock noise patterns (same as in website-monitor.js)
const NOISE_PATTERNS = [
  /^\d+\s*(min|minute|hour|day|sec|second)s?\s*ago$/i,
  /^(just now|moments ago|now)$/i,
  /^\d+(\.\d+)?[kmb]?\s*(views?|likes?|comments?|shares?)$/i,
  /^\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?$/i,
  /^(today|yesterday|tomorrow)\s*(at\s*\d)?/i,
  /^©\s*\d{4}/,
  /^updated?\s*:?\s*\d/i,
  /^\d+\s*(new|unread)/i,
  /^(online|offline|away|busy)$/i,
  /^\$?\d+([,\.]\d+)*\s*(usd|eur|gbp)?$/i,
];

function isLikelyNoise(changedText) {
  if (!changedText || typeof changedText !== 'string') return true;

  const trimmed = changedText.trim();
  if (trimmed.length === 0) return true;

  // First, check if the whole text matches any noise pattern
  if (NOISE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return true;
  }

  // If text is short (< 20 chars), also check by splitting into phrases
  if (trimmed.length < 20) {
    const phrases = trimmed
      .split(/[,;|]/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    return phrases.every((phrase) => NOISE_PATTERNS.some((pattern) => pattern.test(phrase)));
  }

  // Longer text with real content - not noise
  return false;
}

test('detects "5 min ago" as noise', () => {
  assert.strictEqual(isLikelyNoise('5 min ago'), true);
});

test('detects "just now" as noise', () => {
  assert.strictEqual(isLikelyNoise('just now'), true);
});

test('detects "1.2k views" as noise', () => {
  assert.strictEqual(isLikelyNoise('1.2k views'), true);
});

test('detects "10:30 AM" as noise', () => {
  assert.strictEqual(isLikelyNoise('10:30 AM'), true);
});

test('detects "today" as noise', () => {
  assert.strictEqual(isLikelyNoise('today'), true);
});

test('detects "online" status as noise', () => {
  assert.strictEqual(isLikelyNoise('online'), true);
});

test('detects "5 new" as noise', () => {
  assert.strictEqual(isLikelyNoise('5 new'), true);
});

test('real content is NOT noise', () => {
  assert.strictEqual(isLikelyNoise('Product discontinued'), false);
});

test('headline text is NOT noise', () => {
  assert.strictEqual(isLikelyNoise('Breaking News: Major Update Released'), false);
});

test('mixed content with real text is NOT noise', () => {
  assert.strictEqual(isLikelyNoise('New feature announcement'), false);
});

// ========================================
// Text Diff Tests
// ========================================
console.log('\n--- Text Diff Tests ---');

function getTextDiff(oldContent, newContent) {
  if (!oldContent || !newContent) {
    return { totalChanged: 0, changedText: '', addedCount: 0, removedCount: 0 };
  }

  const stripHtml = (html) =>
    html
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const oldText = stripHtml(oldContent);
  const newText = stripHtml(newContent);

  const oldWords = new Set(oldText.toLowerCase().split(/\s+/));
  const newWords = new Set(newText.toLowerCase().split(/\s+/));

  const added = [...newWords].filter((w) => !oldWords.has(w));
  const removed = [...oldWords].filter((w) => !newWords.has(w));

  const changedText = [...added, ...removed].join(' ');
  const totalChanged = changedText.length;

  return { totalChanged, changedText, addedCount: added.length, removedCount: removed.length };
}

test('detects no change for identical content', () => {
  const diff = getTextDiff('Hello world', 'Hello world');
  assert.strictEqual(diff.totalChanged, 0);
});

test('detects added words', () => {
  const diff = getTextDiff('Hello', 'Hello world');
  assert.strictEqual(diff.addedCount, 1);
  assert.ok(diff.changedText.includes('world'));
});

test('detects removed words', () => {
  const diff = getTextDiff('Hello world', 'Hello');
  assert.strictEqual(diff.removedCount, 1);
  assert.ok(diff.changedText.includes('world'));
});

test('strips HTML tags from diff', () => {
  const diff = getTextDiff('<p>Hello</p>', '<p>Hello world</p>');
  assert.strictEqual(diff.addedCount, 1);
});

test('threshold check: less than 50 chars should be filtered', () => {
  const diff = getTextDiff('Hello world', 'Hello there');
  assert.ok(diff.totalChanged < 50, 'Small diff should be under 50 chars');
});

// ========================================
// Change Filtering Tests
// ========================================
console.log('\n--- Change Filtering Tests ---');

function shouldAlertForChange(changeData) {
  const { previousContent, currentContent, diffPercentage } = changeData;

  if (diffPercentage !== undefined && diffPercentage < 5) {
    return { shouldAlert: false, reason: 'visual_threshold' };
  }

  const textDiff = getTextDiff(previousContent, currentContent);
  if (textDiff.totalChanged < 50) {
    return { shouldAlert: false, reason: 'text_threshold' };
  }

  if (isLikelyNoise(textDiff.changedText)) {
    return { shouldAlert: false, reason: 'noise_pattern' };
  }

  return { shouldAlert: true, reason: null };
}

test('filters small visual changes (< 5%)', () => {
  const result = shouldAlertForChange({
    previousContent: 'Test',
    currentContent: 'Test updated',
    diffPercentage: 2,
  });
  assert.strictEqual(result.shouldAlert, false);
  assert.strictEqual(result.reason, 'visual_threshold');
});

test('filters small text changes (< 50 chars)', () => {
  const result = shouldAlertForChange({
    previousContent: 'Hello world test',
    currentContent: 'Hello there test',
  });
  assert.strictEqual(result.shouldAlert, false);
  assert.strictEqual(result.reason, 'text_threshold');
});

test('alerts for significant content changes', () => {
  const result = shouldAlertForChange({
    previousContent: 'Welcome to our website. We offer great products.',
    currentContent:
      'Welcome to our website. BREAKING: Major new product launch announcement coming tomorrow with revolutionary features!',
  });
  assert.strictEqual(result.shouldAlert, true);
});

// ========================================
// Auto-Pause Logic Tests
// ========================================
console.log('\n--- Auto-Pause Logic Tests ---');

function shouldAutoPause(timeline) {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recentChanges = (timeline || []).filter((c) => new Date(c.timestamp).getTime() > oneDayAgo);
  return recentChanges.length >= 5;
}

test('does not pause with few changes', () => {
  const timeline = [{ timestamp: new Date().toISOString() }, { timestamp: new Date().toISOString() }];
  assert.strictEqual(shouldAutoPause(timeline), false);
});

test('pauses with 5+ changes in 24h', () => {
  const now = new Date();
  const timeline = [
    { timestamp: now.toISOString() },
    { timestamp: new Date(now - 1000).toISOString() },
    { timestamp: new Date(now - 2000).toISOString() },
    { timestamp: new Date(now - 3000).toISOString() },
    { timestamp: new Date(now - 4000).toISOString() },
  ];
  assert.strictEqual(shouldAutoPause(timeline), true);
});

test('ignores old changes (> 24h)', () => {
  const now = new Date();
  const twoDaysAgo = new Date(now - 48 * 60 * 60 * 1000);
  const timeline = [
    { timestamp: twoDaysAgo.toISOString() },
    { timestamp: twoDaysAgo.toISOString() },
    { timestamp: twoDaysAgo.toISOString() },
    { timestamp: twoDaysAgo.toISOString() },
    { timestamp: twoDaysAgo.toISOString() },
  ];
  assert.strictEqual(shouldAutoPause(timeline), false);
});

// ========================================
// Error Categorization Tests
// ========================================
console.log('\n--- Error Categorization Tests ---');

function categorizeError(errorMessage) {
  if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
    return { type: 'timeout', message: 'Website took too long to load' };
  } else if (errorMessage.includes('net::ERR_') || errorMessage.includes('ECONNREFUSED')) {
    return { type: 'network', message: 'Could not connect to website' };
  } else if (errorMessage.includes('404') || errorMessage.includes('Not Found')) {
    return { type: 'not_found', message: 'Page not found (404)' };
  } else if (errorMessage.includes('403') || errorMessage.includes('Forbidden')) {
    return { type: 'forbidden', message: 'Access denied (403)' };
  } else if (errorMessage.includes('500') || errorMessage.includes('Internal Server')) {
    return { type: 'server_error', message: 'Website server error (500)' };
  } else if (errorMessage.includes('SSL') || errorMessage.includes('certificate')) {
    return { type: 'ssl', message: 'SSL certificate error' };
  }
  return { type: 'unknown', message: errorMessage };
}

test('categorizes timeout errors', () => {
  const result = categorizeError('Navigation timeout of 30000 ms exceeded');
  assert.strictEqual(result.type, 'timeout');
});

test('categorizes network errors', () => {
  const result = categorizeError('net::ERR_CONNECTION_REFUSED');
  assert.strictEqual(result.type, 'network');
});

test('categorizes 404 errors', () => {
  const result = categorizeError('HTTP 404 Not Found');
  assert.strictEqual(result.type, 'not_found');
});

test('categorizes 403 errors', () => {
  const result = categorizeError('Access Forbidden 403');
  assert.strictEqual(result.type, 'forbidden');
});

test('categorizes 500 errors', () => {
  const result = categorizeError('Internal Server Error 500');
  assert.strictEqual(result.type, 'server_error');
});

test('categorizes SSL errors', () => {
  const result = categorizeError('SSL certificate problem');
  assert.strictEqual(result.type, 'ssl');
});

// ========================================
// System Space Tests
// ========================================
console.log('\n--- System Space Tests ---');

test('system space has correct structure', () => {
  const systemSpace = {
    id: 'web-monitors',
    name: 'Web Monitors',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
    color: '#4a9eff',
    isSystem: true,
  };

  assert.strictEqual(systemSpace.id, 'web-monitors');
  assert.strictEqual(systemSpace.isSystem, true);
  assert.ok(systemSpace.icon.includes('<svg'));
});

test('system space deletion should be blocked', () => {
  const space = { id: 'web-monitors', isSystem: true };

  function canDelete(spaceToDelete) {
    if (spaceToDelete.id === 'unclassified') return false;
    if (spaceToDelete.isSystem) return false;
    return true;
  }

  assert.strictEqual(canDelete(space), false);
});

test('regular space can be deleted', () => {
  const space = { id: 'my-space', isSystem: false };

  function canDelete(spaceToDelete) {
    if (spaceToDelete.id === 'unclassified') return false;
    if (spaceToDelete.isSystem) return false;
    return true;
  }

  assert.strictEqual(canDelete(space), true);
});

// ========================================
// Monitor Item Structure Tests
// ========================================
console.log('\n--- Monitor Item Structure Tests ---');

test('monitor item has required fields', () => {
  const monitorItem = {
    id: 'monitor-123',
    type: 'web-monitor',
    url: 'https://example.com',
    name: 'example.com',
    spaceId: 'web-monitors',
    timestamp: Date.now(),
    monitorId: 'abc123',
    selector: 'body',
    status: 'active',
    settings: { aiDescriptions: false },
    timeline: [],
    unviewedChanges: 0,
    costTracking: { monthlyTokensUsed: 0, monthlyCost: 0 },
  };

  assert.strictEqual(monitorItem.type, 'web-monitor');
  assert.strictEqual(monitorItem.spaceId, 'web-monitors');
  assert.strictEqual(monitorItem.settings.aiDescriptions, false); // Default OFF
  assert.ok(Array.isArray(monitorItem.timeline));
});

test('timeline entry has required fields', () => {
  const timelineEntry = {
    id: 'change-123',
    timestamp: new Date().toISOString(),
    beforeScreenshotPath: '/path/to/before.png',
    afterScreenshotPath: '/path/to/after.png',
    diffScreenshotPath: null,
    aiSummary: 'Content updated',
    diffPercentage: 10,
    contentDiff: { added: 5, removed: 2, modified: 3 },
  };

  assert.ok(timelineEntry.id);
  assert.ok(timelineEntry.timestamp);
  assert.ok(timelineEntry.aiSummary);
});

// ========================================
// Vitest wrapper -- validates all inline tests passed
// ========================================

describe('Web Monitors', () => {
  it(`should pass all ${results.passed + results.failed} monitor tests`, () => {
    if (results.failed > 0) {
      const failedNames = results.tests
        .filter((t) => t.status === 'FAIL')
        .map((t) => `${t.name}: ${t.error}`)
        .join('\n  ');
      expect.unreachable(`${results.failed} test(s) failed:\n  ${failedNames}`);
    }
    expect(results.passed).toBeGreaterThan(0);
  });
});
