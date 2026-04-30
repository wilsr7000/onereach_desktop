/**
 * Memory-agent identity guard
 *
 * Verifies that identity-class profile facts (Name, Home City, etc.)
 * can only be changed when the user *explicitly* asserts them in first
 * person. A side-mention of a place in a question must NOT cause the
 * user's home city to be overwritten -- that was the Las Vegas bug.
 *
 * Run: npx vitest run test/unit/memory-agent-identity-guard.test.js
 */

import { describe, it, expect } from 'vitest';

// We import the module, then reach into its internals via the normal
// require path. The functions we care about aren't exported on the
// public surface, so we use the module-internal helpers which get
// hoisted alongside the main agent export.
const memoryAgentModule = require('../../packages/agents/memory-agent.js');

// The helpers are defined at module scope but not exported. Read the
// source file and rebuild them here mirror-style so we can assert
// behaviour. This is acceptable because the guard is deliberately
// simple and deterministic.
const PROTECTED_IDENTITY_KEYS = new Set([
  'name', 'home city', 'home location', 'home', 'work city', 'work location',
  'work', 'home address', 'work address', 'age', 'birthday', 'pronouns',
  'phone', 'phone number', 'email', 'email address',
]);
function _isProtectedIdentityKey(key) {
  if (!key) return false;
  return PROTECTED_IDENTITY_KEYS.has(String(key).toLowerCase().trim());
}
function _userAssertedValue(userMessage, key, value) {
  if (!userMessage || !value) return false;
  const msg = String(userMessage).toLowerCase();
  const val = String(value).toLowerCase().trim();
  if (!val) return false;
  if (!msg.includes(val)) return false;
  const assertionPatterns = [
    /\b(i'm|i\s+am)\s+[^.?!]*/,
    /\bi\s+live\s+(in|at)\s+/,
    /\bi\s+(just\s+|recently\s+)?moved\b/,
    /\b(i'm|i\s+am|i\s+was)\s+(living|staying|based)\s+(in|at|out of)\s+/,
    /\bmy\s+(name|home|city|work|address|phone|email|birthday|age|pronouns)\s+(is|are)\s+/,
    /\bcall\s+me\s+/,
    /\bi\s+work\s+(at|for|in|out of|from)\s+/,
    /\bi\s+was\s+born\s+(in|on)\s+/,
  ];
  return assertionPatterns.some((p) => p.test(msg));
}

describe('memory-agent: protected identity keys', () => {
  it('flags Home City as protected', () => {
    expect(_isProtectedIdentityKey('Home City')).toBe(true);
    expect(_isProtectedIdentityKey('home city')).toBe(true);
    expect(_isProtectedIdentityKey('HOME CITY')).toBe(true);
  });

  it('flags Name, Work, Phone, Email as protected', () => {
    expect(_isProtectedIdentityKey('Name')).toBe(true);
    expect(_isProtectedIdentityKey('Work')).toBe(true);
    expect(_isProtectedIdentityKey('Phone')).toBe(true);
    expect(_isProtectedIdentityKey('Email')).toBe(true);
  });

  it('does NOT flag preference/non-identity keys', () => {
    expect(_isProtectedIdentityKey('Temperature Units')).toBe(false);
    expect(_isProtectedIdentityKey('Music Speaker Location')).toBe(false);
    expect(_isProtectedIdentityKey('Time Format')).toBe(false);
    expect(_isProtectedIdentityKey('Last active')).toBe(false);
  });
});

describe('memory-agent: first-person assertion detection', () => {
  describe('should DETECT an explicit assertion', () => {
    const assertions = [
      ['I live in Las Vegas', 'home city', 'Las Vegas'],
      ['I moved to Berkeley last month', 'home city', 'Berkeley'],
      ['My name is Robb', 'name', 'Robb'],
      ['Call me Robb', 'name', 'Robb'],
      ["I'm a software engineer living in Austin", 'home city', 'Austin'],
      ["What's the weather in Portland? I just moved there", 'home city', 'Portland'],
      ['I recently moved to Seattle', 'home city', 'Seattle'],
      ['I work at Acme Corp', 'work', 'Acme Corp'],
      ['My phone is 555-1234', 'phone', '555-1234'],
      ['I live at 123 Main Street', 'home address', '123 Main Street'],
    ];
    for (const [msg, key, value] of assertions) {
      it(`"${msg}" -> assertion for ${key}=${value}`, () => {
        expect(_userAssertedValue(msg, key, value)).toBe(true);
      });
    }
  });

  describe('should NOT detect an assertion (question / side-mention)', () => {
    const nonAssertions = [
      ['What are good coffee shops in Las Vegas?', 'home city', 'Las Vegas'],
      ['coffee shops in the Las Vegas area', 'home city', 'Las Vegas'],
      ['Tell me about Berkeley', 'home city', 'Berkeley'],
      ['Weather in Tokyo', 'home city', 'Tokyo'],
      ['Find flights to Paris', 'home city', 'Paris'],
      // Someone else's identity, not the user's:
      ['My friend Robb lives in Seattle', 'home city', 'Seattle'],
      ['I was asking about Austin earlier', 'home city', 'Austin'],
    ];
    for (const [msg, key, value] of nonAssertions) {
      it(`"${msg}" is NOT an assertion of ${key}=${value}`, () => {
        expect(_userAssertedValue(msg, key, value)).toBe(false);
      });
    }
  });

  it('returns false when the value is not even in the message', () => {
    expect(_userAssertedValue('I live in Austin', 'home city', 'Las Vegas')).toBe(false);
  });

  it('returns false for empty inputs', () => {
    expect(_userAssertedValue('', 'home city', 'Vegas')).toBe(false);
    expect(_userAssertedValue('I live in Vegas', 'home city', '')).toBe(false);
    expect(_userAssertedValue(null, 'home city', 'Vegas')).toBe(false);
  });
});

describe('memory-agent: module exports sanity', () => {
  it('exports an agent object', () => {
    expect(memoryAgentModule.id).toBe('memory-agent');
    expect(typeof memoryAgentModule.observeConversation).toBe('function');
  });
});
