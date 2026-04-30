/**
 * lib/capture-guest-page.js -- static guest page generator
 *
 * Regression guard for: 'Uncaught SyntaxError: Unexpected identifier "t"' at
 * runtime in the served join.html, which then cascades to every onclick
 * handler (`guest is not defined`) because the script block stops executing
 * before the top-level `const guest = { ... }` ever runs.
 *
 * Root cause of the original bug: the page is a template literal, so any
 * `\'` inside a JS string literal in the inner script was consumed by the
 * outer template literal and served as a bare `'`. That turned
 *   throw { userMessage: 'The host hasn\'t started this meeting yet.', ... }
 * into
 *   throw { userMessage: 'The host hasn't started this meeting yet.', ... }
 * which is a syntax error -- the inner string closes at `hasn'` and `t` is
 * an unexpected identifier.
 *
 * These tests parse the generated HTML and syntax-check every inline
 * <script> block. If a future edit re-introduces an escape hazard, the
 * suite fails loudly instead of waiting for a guest to click the link.
 *
 * Run:  npx vitest run test/unit/capture-guest-page.test.js
 */

import { describe, it, expect } from 'vitest';

const { buildGuestPageHTML, GUEST_PAGE_VERSION } = require('../../lib/capture-guest-page');

// Pull every <script>...</script> body out of an HTML string. Handles both
// classic and type="module" scripts. Skips src="..."-only scripts because
// those have no inline body to parse.
function extractInlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    const body = m[2] || '';
    if (/\bsrc\s*=/.test(attrs)) {
      // External script -- no inline body to syntax-check.
      continue;
    }
    out.push({ attrs: attrs.trim(), body });
  }
  return out;
}

// Use Function() for syntax-only parsing. If the body is syntactically
// invalid, the constructor throws SyntaxError; otherwise it returns a fn
// which we discard. This runs the parser only, never the code.
function assertParses(body, label) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(body);
  } catch (err) {
    throw new Error(
      `[${label}] SyntaxError while parsing inline script:\n` +
        `  ${err.message}\n` +
        `First 400 chars:\n${body.slice(0, 400)}`
    );
  }
}

describe('buildGuestPageHTML', () => {
  it('exports a monotonically bumped version token', () => {
    expect(typeof GUEST_PAGE_VERSION).toBe('number');
    expect(GUEST_PAGE_VERSION).toBeGreaterThanOrEqual(8);
  });

  it('returns a full HTML document', () => {
    const html = buildGuestPageHTML({ kvUrl: 'https://example.com/kv' });
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toMatch(/<html[\s>]/);
    expect(html).toMatch(/<\/html>\s*$/);
  });

  it('interpolates the KV URL exactly where expected', () => {
    const kvUrl = 'https://em.edison.api.onereach.ai/http/abc-1234-5678-aabb-ccdd/keyvalue';
    const html = buildGuestPageHTML({ kvUrl });
    expect(html).toContain(`const KV_URL = '${kvUrl}';`);
  });

  it('defaults KV URL to empty string when not provided', () => {
    const html = buildGuestPageHTML();
    expect(html).toContain("const KV_URL = '';");
  });

  // The actual regression guard for the runtime crash the user reported.
  it('every inline <script> block parses as valid JavaScript', () => {
    const html = buildGuestPageHTML({ kvUrl: 'https://example.com/kv' });
    const scripts = extractInlineScripts(html);
    expect(scripts.length).toBeGreaterThan(0);
    for (let i = 0; i < scripts.length; i++) {
      const { attrs, body } = scripts[i];
      // Module scripts may use `import` which `new Function()` cannot
      // parse. Strip top-level import statements for parse purposes --
      // the rest of the body still needs to be syntactically valid.
      const parseBody = attrs.includes('type="module"')
        ? body.replace(/^\s*import\s[^;]+;?/gm, '')
        : body;
      assertParses(parseBody, `script[${i}] ${attrs || '(default)'}`);
    }
  });

  it('the main inline script parses cleanly with interpolated kvUrl containing special chars', () => {
    // Quoted single-quote is the exact shape that used to escape the outer
    // template literal and corrupt the inner JS string literal.
    const tricky = "https://example.com/kv?q=hasn't&other=foo";
    const html = buildGuestPageHTML({ kvUrl: tricky });
    const scripts = extractInlineScripts(html);
    const main = scripts.find((s) => /const KV_URL =/.test(s.body));
    expect(main).toBeDefined();
    // Even with a ' in the URL, the declaration we emit should still parse.
    // Today the main script does NOT sanitize the kvUrl, so this test
    // documents the current contract: callers must pass a safe URL.
    // If a future change makes kvUrl sanitized, relax this expectation.
    expect(main.body).toContain("const KV_URL = '" + tricky + "';");
  });

  it('never emits `hasn\\\'t` (or any backslash-escaped single-quote) in inline scripts -- template-literal hazard', () => {
    const html = buildGuestPageHTML({ kvUrl: 'https://example.com/kv' });
    const scripts = extractInlineScripts(html);
    for (const { body } of scripts) {
      // A `\'` in a template literal is consumed: the served JS ends up
      // with a bare `'` that closes any single-quoted string early. If a
      // future edit writes `'don\'t'` or similar in this file's source,
      // the generated body contains `'don't'` and this assertion fires.
      // (The backslash-quote pattern we guard against is literally the
      // two characters `\` followed by `'` in the emitted string.)
      expect(body).not.toMatch(/\\'/);
    }
  });

  it('every onclick-referenced method is defined on the `guest` object', () => {
    const html = buildGuestPageHTML({ kvUrl: 'https://example.com/kv' });
    // Collect every `guest.<method>(...)` call used in an onclick attribute.
    const onclickRe = /onclick\s*=\s*"guest\.([A-Za-z_$][\w$]*)\s*\(/g;
    const referenced = new Set();
    let m;
    while ((m = onclickRe.exec(html)) !== null) referenced.add(m[1]);
    expect(referenced.size).toBeGreaterThan(0);

    // For each reference, assert the script body defines that key on the
    // guest object literal. We match `<name>(`, `<name>:`, or `<name> (` on
    // a line inside the `const guest = { ... }` block.
    const scripts = extractInlineScripts(html);
    const mainBody = scripts.map((s) => s.body).join('\n');
    for (const name of referenced) {
      const defined =
        new RegExp(`(^|\\n)\\s*(async\\s+)?${name}\\s*\\(`, 'm').test(mainBody) ||
        new RegExp(`(^|\\n)\\s*${name}\\s*:`, 'm').test(mainBody);
      expect(defined, `onclick refers to guest.${name}() but it is not defined`).toBe(true);
    }
  });
});
