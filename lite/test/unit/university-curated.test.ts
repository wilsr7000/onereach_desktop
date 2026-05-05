/**
 * Curated catalog completeness + UI metadata tests.
 *
 * Verifies the hand-curated content matches the menu structure and
 * that every kind has UI metadata.
 */

import { describe, it, expect } from 'vitest';
import {
  CURATED,
  KIND_UI,
  findCurated,
  getTopLevelMenuEntries,
  LMS_BASE_URL,
  AI_RUN_TIMES_URL,
  WISER_METHOD_URL,
} from '../../university/curated-content.js';
import { LEARNING_KINDS } from '../../university/types.js';

describe('CURATED catalog', () => {
  it('contains every menu-bound entry', () => {
    const ids = CURATED.map((e) => e.id);
    expect(ids).toContain('lms');
    expect(ids).toContain('getting-started');
    expect(ids).toContain('first-agent');
    expect(ids).toContain('workflow-basics');
    expect(ids).toContain('api-integration');
    expect(ids).toContain('ai-run-times');
    expect(ids).toContain('wiser-method');
  });

  it('every entry has http/https URL + non-empty title + description', () => {
    for (const entry of CURATED) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.url).toMatch(/^https?:\/\//);
    }
  });

  it('LMS entry uses LMS_BASE_URL', () => {
    const lms = findCurated('lms');
    expect(lms?.url.startsWith(LMS_BASE_URL)).toBe(true);
  });

  it('every course points at LMS_BASE_URL/courses/...', () => {
    const courses = CURATED.filter((e) => e.kind === 'course');
    expect(courses.length).toBe(4);
    for (const course of courses) {
      expect(course.url.startsWith(`${LMS_BASE_URL}/courses/`)).toBe(true);
    }
  });

  it('AI Run Times entry uses AI_RUN_TIMES_URL', () => {
    const f = findCurated('ai-run-times');
    expect(f?.url).toBe(AI_RUN_TIMES_URL);
  });

  it('Wiser Method entry uses WISER_METHOD_URL', () => {
    const w = findCurated('wiser-method');
    expect(w?.url).toBe(WISER_METHOD_URL);
  });

  it('findCurated returns null for unknown ids', () => {
    expect(findCurated('does-not-exist')).toBeNull();
  });

  it('getTopLevelMenuEntries returns entries with inTopLevelMenu=true', () => {
    const top = getTopLevelMenuEntries();
    expect(top.length).toBeGreaterThan(0);
    for (const entry of top) {
      expect(entry.inTopLevelMenu).toBe(true);
    }
  });
});

describe('KIND_UI', () => {
  it('has an entry for every LearningKind', () => {
    for (const kind of LEARNING_KINDS) {
      expect(KIND_UI[kind]).toBeDefined();
    }
  });

  it('every entry has a label, accent var, hex, default emoji', () => {
    for (const kind of LEARNING_KINDS) {
      const meta = KIND_UI[kind];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.pluralLabel.length).toBeGreaterThan(0);
      expect(meta.accentVar.length).toBeGreaterThan(0);
      expect(meta.accentHex).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(meta.defaultIconEmoji.length).toBeGreaterThan(0);
    }
  });

  it('every accent var is unique', () => {
    const vars = new Set<string>();
    for (const kind of LEARNING_KINDS) vars.add(KIND_UI[kind].accentVar);
    expect(vars.size).toBe(LEARNING_KINDS.length);
  });
});
