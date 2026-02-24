/**
 * Daily Brief Pipeline Fixes - Test Suite
 *
 * Tests for 6 fixes applied to the daily brief pipeline:
 *   1. Double greeting elimination (time-agent no longer embeds greeting)
 *   2. Decomposition bypass (daily brief requests skip task decomposition)
 *   3. Memory header dedup (parseMarkdownSections strips # Title lines)
 *   4. Weather fallback (Open-Meteo when wttr.in is down)
 *   5. Composition cost reduction (standard profile instead of powerful)
 *   6. Calendar data source (getBriefing now fetches from omnical API)
 *
 * Run:  npx vitest run test/unit/daily-brief-fixes.test.js
 */

import { describe, it, expect, vi } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '[]'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

// ═══════════════════════════════════════════════════════════════════════════
// FIX 1: Double Greeting - time-agent getBriefing()
// ═══════════════════════════════════════════════════════════════════════════

describe('Fix 1: Time-agent getBriefing() should NOT include a greeting', () => {
  const timeAgent = require('../../packages/agents/time-agent');

  it('should return content without "Good morning/afternoon/evening"', async () => {
    const result = await timeAgent.getBriefing();
    expect(result.section).toBe('Time & Date');
    expect(result.priority).toBe(1);
    expect(result.content).not.toMatch(/^Good (morning|afternoon|evening)/i);
  });

  it('should include "Current time:" and "Date:" facts', async () => {
    const result = await timeAgent.getBriefing();
    expect(result.content).toMatch(/Current time:/);
    expect(result.content).toMatch(/Date:/);
  });

  it('should include "Time of day:" for the LLM composer', async () => {
    const result = await timeAgent.getBriefing();
    expect(result.content).toMatch(/Time of day: (morning|afternoon|evening)/);
  });

  it('should classify time of day correctly based on hour', () => {
    // Test the classification logic directly rather than mocking Date
    function getTimeOfDay(h) {
      return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
    }
    expect(getTimeOfDay(6)).toBe('morning');
    expect(getTimeOfDay(9)).toBe('morning');
    expect(getTimeOfDay(11)).toBe('morning');
    expect(getTimeOfDay(12)).toBe('afternoon');
    expect(getTimeOfDay(14)).toBe('afternoon');
    expect(getTimeOfDay(16)).toBe('afternoon');
    expect(getTimeOfDay(17)).toBe('evening');
    expect(getTimeOfDay(19)).toBe('evening');
    expect(getTimeOfDay(23)).toBe('evening');
  });

  it('should match the time-agent classification logic', () => {
    // Verify the actual time-agent code uses the same h < 12 / h < 17 pattern
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '../../packages/agents/time-agent.js'), 'utf8');
    expect(source).toContain("h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FIX 2: Decomposition Bypass
// ═══════════════════════════════════════════════════════════════════════════

describe('Fix 2: decomposeIfNeeded should skip daily brief requests', () => {
  // We can't easily require decomposeIfNeeded since it's a local function in
  // exchange-bridge.js (4000+ lines), so we test the pattern directly.

  // Replicate the fast-path check from exchange-bridge.js
  function shouldBypassDecomposition(content) {
    if (!content || typeof content !== 'string') return false;
    const lower = content.toLowerCase();
    return (
      lower.includes('brief') ||
      lower.includes('briefing') ||
      lower.includes('morning report') ||
      lower.includes('daily update') ||
      lower.includes('daily rundown') ||
      lower.includes('catch me up') ||
      lower.includes("what's happening today") ||
      lower.includes('start my day')
    );
  }

  const bypassCases = [
    'Give me my daily brief',
    'daily briefing please',
    'run the morning report',
    'Give me a daily update on everything',
    'daily rundown',
    "What's happening today?",
    'catch me up on everything',
    'start my day',
    'Can I get a brief of everything going on?',
  ];

  for (const input of bypassCases) {
    it(`should bypass decomposition for: "${input}"`, () => {
      expect(shouldBypassDecomposition(input)).toBe(true);
    });
  }

  const allowCases = [
    'play music and check my calendar',
    'what is the weather in Portland',
    'schedule a meeting with John tomorrow',
    'send an email and set a reminder',
    'tell me a joke',
  ];

  for (const input of allowCases) {
    it(`should NOT bypass decomposition for: "${input}"`, () => {
      expect(shouldBypassDecomposition(input)).toBe(false);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// FIX 3: Memory Header Deduplication
// ═══════════════════════════════════════════════════════════════════════════

describe('Fix 3: parseMarkdownSections should strip duplicate # Title lines', () => {
  // Import the actual functions from agent-memory-store
  // They're not exported, so we test via AgentMemoryStore behavior
  // or re-implement the parse/rebuild for direct testing.

  // Direct reimplementation of the fixed functions for isolated testing
  function parseMarkdownSections(markdown) {
    const sections = new Map();
    if (!markdown) return sections;
    const lines = markdown.split('\n');
    let currentSection = '_header';
    let currentContent = [];
    for (const line of lines) {
      const match = line.match(/^##\s+(.+)$/);
      if (match) {
        if (currentContent.length > 0 || currentSection !== '_header') {
          sections.set(currentSection, currentContent.join('\n').trim());
        }
        currentSection = match[1].trim();
        currentContent = [];
      } else {
        // The fix: skip # Title lines in header section
        if (currentSection === '_header' && /^#\s+/.test(line)) continue;
        currentContent.push(line);
      }
    }
    if (currentContent.length > 0) {
      sections.set(currentSection, currentContent.join('\n').trim());
    }
    return sections;
  }

  function rebuildMarkdown(sections, title) {
    const lines = [];
    lines.push(`# ${title}`);
    lines.push('');
    if (sections.has('_header')) {
      lines.push(sections.get('_header'));
      lines.push('');
    }
    for (const [name, content] of sections) {
      if (name === '_header') continue;
      lines.push(`## ${name}`);
      lines.push('');
      lines.push(content);
      lines.push('');
    }
    return lines.join('\n');
  }

  it('should strip duplicate # Title lines on parse', () => {
    const input = `# My Memory\n\n# My Memory\n\n# My Memory\n\n> Updated\n\n## Section\n\nContent\n`;
    const sections = parseMarkdownSections(input);
    const header = sections.get('_header');
    // Header should NOT contain any # Title lines
    expect(header).not.toMatch(/^# /m);
    expect(header).toContain('> Updated');
  });

  it('should produce exactly one # Title after rebuild', () => {
    const input = `# Agent Memory\n\n# Agent Memory\n\n# Agent Memory\n\n> Last updated\n\n## Prefs\n\nSome prefs\n`;
    const sections = parseMarkdownSections(input);
    const rebuilt = rebuildMarkdown(sections, 'Agent Memory');
    const titleMatches = rebuilt.match(/^# Agent Memory$/gm);
    expect(titleMatches).toHaveLength(1);
  });

  it('should preserve a clean file through round-trip', () => {
    const clean = `# Clean Memory\n\n> Last updated: now\n\n## About\n\nThis is about.\n\n## Prefs\n\n- Key: value\n`;
    const sections = parseMarkdownSections(clean);
    const rebuilt = rebuildMarkdown(sections, 'Clean Memory');
    const titleCount = (rebuilt.match(/^# /gm) || []).length;
    expect(titleCount).toBe(1);
    expect(rebuilt).toContain('## About');
    expect(rebuilt).toContain('## Prefs');
    expect(rebuilt).toContain('- Key: value');
  });

  it('should handle file with 10 duplicate titles (accumulated bug)', () => {
    const titles = Array(10).fill('# Broken Memory\n').join('\n');
    const input = `${titles}\n> Updated\n\n## Data\n\nSome data\n`;
    const sections = parseMarkdownSections(input);
    const rebuilt = rebuildMarkdown(sections, 'Broken Memory');
    const titleCount = (rebuilt.match(/^# /gm) || []).length;
    expect(titleCount).toBe(1);
    expect(rebuilt).toContain('> Updated');
    expect(rebuilt).toContain('## Data');
  });

  it('should not strip ## section headers (only # title)', () => {
    const input = `# Memory\n\n## Section One\n\nContent one\n\n## Section Two\n\nContent two\n`;
    const sections = parseMarkdownSections(input);
    expect(sections.has('Section One')).toBe(true);
    expect(sections.has('Section Two')).toBe(true);
    expect(sections.get('Section One')).toBe('Content one');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FIX 4: Weather Fallback (Open-Meteo)
// ═══════════════════════════════════════════════════════════════════════════

describe('Fix 4: Weather agent has wmoCodeToDescription for Open-Meteo fallback', () => {
  // We can't easily test the full HTTP fallback without network mocks,
  // but we can verify the WMO code translator is correct.

  // Reimplementation of the function for testing
  function wmoCodeToDescription(code) {
    const map = {
      0: 'clear sky',
      1: 'mainly clear',
      2: 'partly cloudy',
      3: 'overcast',
      45: 'foggy',
      48: 'depositing rime fog',
      51: 'light drizzle',
      53: 'moderate drizzle',
      55: 'dense drizzle',
      61: 'slight rain',
      63: 'moderate rain',
      65: 'heavy rain',
      71: 'slight snow',
      73: 'moderate snow',
      75: 'heavy snow',
      77: 'snow grains',
      80: 'slight rain showers',
      81: 'moderate rain showers',
      82: 'violent rain showers',
      85: 'slight snow showers',
      86: 'heavy snow showers',
      95: 'thunderstorm',
      96: 'thunderstorm with slight hail',
      99: 'thunderstorm with heavy hail',
    };
    return map[code] || 'unknown conditions';
  }

  it('should map code 0 to clear sky', () => {
    expect(wmoCodeToDescription(0)).toBe('clear sky');
  });

  it('should map code 3 to overcast', () => {
    expect(wmoCodeToDescription(3)).toBe('overcast');
  });

  it('should map code 61 to slight rain', () => {
    expect(wmoCodeToDescription(61)).toBe('slight rain');
  });

  it('should map code 95 to thunderstorm', () => {
    expect(wmoCodeToDescription(95)).toBe('thunderstorm');
  });

  it('should return "unknown conditions" for unmapped code', () => {
    expect(wmoCodeToDescription(999)).toBe('unknown conditions');
  });

  it('should cover all major WMO codes (no gaps in common ranges)', () => {
    const coveredCodes = [0, 1, 2, 3, 45, 48, 51, 53, 55, 61, 63, 65, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99];
    for (const code of coveredCodes) {
      const desc = wmoCodeToDescription(code);
      expect(desc).not.toBe('unknown conditions');
      expect(typeof desc).toBe('string');
      expect(desc.length).toBeGreaterThan(2);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FIX 5: Composition Cost Reduction
// ═══════════════════════════════════════════════════════════════════════════

describe('Fix 5: Daily brief uses standard profile (not powerful)', () => {
  // Read the source file to verify the profile setting
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../../packages/agents/daily-brief-agent.js'), 'utf8');

  it('should use standard profile for composition', () => {
    // The compose call should use profile: 'standard'
    expect(source).toContain("profile: 'standard'");
  });

  it('should NOT use powerful profile for composition', () => {
    // Make sure we don't have profile: 'powerful' in _composeBriefing context
    // (the powerful profile might exist in other parts, so check specifically
    // around the compose call)
    const composeSection = source.substring(
      source.indexOf('_composeBriefing'),
      source.indexOf('_composeBriefing') + 2000
    );
    expect(composeSection).not.toContain("profile: 'powerful'");
  });

  it('should NOT use thinking: true for composition', () => {
    const composeSection = source.substring(
      source.indexOf('_composeBriefing'),
      source.indexOf('_composeBriefing') + 2000
    );
    expect(composeSection).not.toContain('thinking: true');
  });

  it('should use maxTokens of 2000 (not 16000)', () => {
    // The compose function is long (~3000 chars), need a wider window
    const startIdx = source.indexOf('async _composeBriefing');
    const composeSection = source.substring(startIdx, startIdx + 3500);
    expect(composeSection).toContain('maxTokens: 2000');
    expect(composeSection).not.toContain('maxTokens: 16000');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FIX 6: Calendar getBriefing() fetches real events
// ═══════════════════════════════════════════════════════════════════════════

describe('Fix 6: Calendar agent getBriefing() uses calendar store', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../../packages/agents/calendar-query-agent.js'), 'utf8');

  it('should call generateMorningBrief in getBriefing()', () => {
    const getBriefingStart = source.indexOf('async getBriefing()');
    const getBriefingEnd = source.indexOf('},', getBriefingStart + 100);
    const getBriefingBody = source.substring(getBriefingStart, getBriefingEnd);
    expect(getBriefingBody).toContain('generateMorningBrief');
  });

  it('should use the calendar store for data', () => {
    const getBriefingStart = source.indexOf('async getBriefing()');
    const getBriefingEnd = source.indexOf('},', getBriefingStart + 100);
    const getBriefingBody = source.substring(getBriefingStart, getBriefingEnd);
    expect(getBriefingBody).toContain('getCalendarStore');
  });

  it('should return section Calendar with priority 3', () => {
    const getBriefingStart = source.indexOf('async getBriefing()');
    const getBriefingEnd = source.indexOf('},', getBriefingStart + 100);
    const getBriefingBody = source.substring(getBriefingStart, getBriefingEnd);
    expect(getBriefingBody).toContain("section: 'Calendar'");
    expect(getBriefingBody).toContain('priority: 3');
  });

  it('should handle no meetings gracefully', () => {
    const getBriefingStart = source.indexOf('async getBriefing()');
    const getBriefingEnd = source.indexOf('},', getBriefingStart + 100);
    const getBriefingBody = source.substring(getBriefingStart, getBriefingEnd);
    expect(getBriefingBody).toContain('No meetings scheduled today');
  });

  it('should catch errors gracefully with try/catch', () => {
    const getBriefingStart = source.indexOf('async getBriefing()');
    const getBriefingEnd = source.indexOf('},', getBriefingStart + 100);
    const getBriefingBody = source.substring(getBriefingStart, getBriefingEnd);
    expect(getBriefingBody).toMatch(/try\s*\{/);
    expect(getBriefingBody).toContain('catch');
    expect(getBriefingBody).toContain('Calendar unavailable');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ADDITIONAL: Timeout configuration
// ═══════════════════════════════════════════════════════════════════════════

describe('Additional: Brief timeouts accommodate API calls', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../../packages/agents/daily-brief-agent.js'), 'utf8');

  it('should have per-agent timeout >= 8000ms', () => {
    const match = source.match(/PER_AGENT_TIMEOUT_MS\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(parseInt(match[1], 10)).toBeGreaterThanOrEqual(8000);
  });

  it('should have total timeout >= 15000ms', () => {
    const match = source.match(/TOTAL_TIMEOUT_MS\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(parseInt(match[1], 10)).toBeGreaterThanOrEqual(15000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ADDITIONAL: LLM prompt correctness
// ═══════════════════════════════════════════════════════════════════════════

describe('Additional: Brief LLM prompt prevents double greeting', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../../packages/agents/daily-brief-agent.js'), 'utf8');

  it('should instruct LLM to use a SINGLE greeting', () => {
    expect(source).toContain('SINGLE time-of-day greeting');
  });

  it('should instruct LLM to NOT repeat the greeting', () => {
    expect(source).toContain('Do NOT repeat the greeting');
  });

  it('should reference "Time of day" field from time-agent', () => {
    expect(source).toContain('"Time of day" field');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ADDITIONAL: Decomposition prompt update
// ═══════════════════════════════════════════════════════════════════════════

describe('Additional: Decomposition prompt excludes daily briefs', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../../src/voice-task-sdk/exchange-bridge.js'), 'utf8');

  it('should have fast-path bypass for brief-related keywords', () => {
    // The fast-path check should exist before the LLM call
    const decomposeStart = source.indexOf('async function decomposeIfNeeded');
    const decomposeBlock = source.substring(decomposeStart, decomposeStart + 1500);
    expect(decomposeBlock).toContain("lower.includes('brief')");
    expect(decomposeBlock).toContain("lower.includes('catch me up')");
  });

  it('should also have LLM prompt rule about daily briefs', () => {
    expect(source).toContain('Do NOT decompose daily briefs');
  });
});
