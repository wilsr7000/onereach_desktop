/**
 * A journey map is a content type this app accepts (ADR-072).
 *
 * `VALID_TYPES` is an allow-list, and `spaces-api.js` THROWS on anything
 * outside it. That made journeys unstorable over the REST API: the
 * Journey Map Builder wanted to POST `type: 'journey'`, got "Invalid
 * content type", and fell back to `'data-source'` — the nearest thing
 * the list would accept. A journey then arrived indistinguishable from a
 * database connection and rendered as one everywhere it was shown.
 *
 * So the allow-list is the contract between the Builder and this app,
 * and it is pinned here. The failure it prevents is silent: nothing
 * crashes when 'journey' goes missing, the Builder just quietly files
 * journeys as something else again.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { VALID_TYPES } = require('../../content-ingestion.js');

describe('accepted content types', () => {
  it('accepts a journey map', () => {
    expect(
      VALID_TYPES,
      "journeys cannot be saved over the REST API without 'journey' here"
    ).toContain('journey');
  });

  it('still accepts everything it did before', () => {
    // Removing a type breaks whatever was storing it. This is the
    // regression guard for the list as a whole, not just the new entry.
    for (const type of [
      'text',
      'html',
      'image',
      'file',
      'code',
      'url',
      'web-monitor',
      'data-source',
    ]) {
      expect(VALID_TYPES).toContain(type);
    }
  });

  it('has no duplicates and no empty entries', () => {
    expect(new Set(VALID_TYPES).size).toBe(VALID_TYPES.length);
    expect(VALID_TYPES.every((t) => typeof t === 'string' && t.length > 0)).toBe(true);
  });
});
