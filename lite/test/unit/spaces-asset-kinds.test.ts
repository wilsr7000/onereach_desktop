/**
 * ADR-098 — the asset-kind registry is the one source of truth, and
 * every surface that used to hand-copy the kind list now derives from
 * it. These tests pin the registry's own invariants: it agrees with the
 * `ItemKind` union and the bridge typings, every kind has the copy and
 * classification a surface needs, aliases resolve the full app's
 * vocabulary, and files are recognised by name before MIME.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ITEM_KINDS } from '../../spaces/types.js';
import {
  ASSET_KINDS,
  FAMILY_ORDER,
  creatableKinds,
  inferKindFromFile,
  inferKindFromMime,
  kindFields,
  kindLabel,
  kindSpec,
  normalizeKind,
  reclassifiableKinds,
  registryKinds,
  sniffJsonKind,
  typedMetadataKeys,
} from '../../spaces/asset-kinds.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('asset-kind registry — agreement with the union and the bridge', () => {
  it('has exactly one row per ItemKind, in a stable order', () => {
    expect([...registryKinds()].sort()).toEqual([...ITEM_KINDS].sort());
    const ids = ASSET_KINDS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('mirrors the bridge union in lite-window.d.ts (a hand-copied mirror drifts)', () => {
    const dts = fs.readFileSync(path.join(here, '../../lite-window.d.ts'), 'utf8');
    const start = dts.indexOf('type LiteSpaceItemKind =');
    const end = dts.indexOf(';', start);
    const block = dts.slice(start, end);
    const members = Array.from(block.matchAll(/'([a-z-]+)'/g)).map((m) => m[1]);
    expect([...members].sort()).toEqual([...ITEM_KINDS].sort());
  });

  it('mirrors the schema annotation the SDK publishes to the graph', () => {
    const sdk = fs.readFileSync(path.join(here, '../../spaces/sdk-client.ts'), 'utf8');
    const m = /type: ItemKind \(([a-z|-]+)/.exec(sdk);
    expect(m, 'annotation enum missing').not.toBeNull();
    const listed = (m as RegExpExecArray)[1]!.split('|');
    expect([...listed].sort()).toEqual([...ITEM_KINDS].sort());
  });
});

describe('asset-kind registry — every row is complete', () => {
  for (const spec of ASSET_KINDS) {
    it(`${spec.id} has a label, a glyph, an accent, a family, copy, and an empty state`, () => {
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.glyph.length).toBeGreaterThan(0);
      expect(spec.accent).toMatch(/^\d{1,3}, \d{1,3}, \d{1,3}$/);
      expect(FAMILY_ORDER).toContain(spec.family);
      expect(spec.hint.length).toBeGreaterThan(8);
      expect(spec.empty.headline.length).toBeGreaterThan(0);
      expect(spec.empty.sub.length).toBeGreaterThan(0);
      // The kit uses no emoji glyphs (monochrome symbols only).
      expect(spec.glyph).not.toMatch(/\p{Emoji_Presentation}/u);
    });
  }

  it('field keys are unique per kind and every select has options', () => {
    for (const spec of ASSET_KINDS) {
      const keys = spec.fields.map((f) => f.key);
      expect(new Set(keys).size, `${spec.id} duplicate field keys`).toBe(keys.length);
      for (const f of spec.fields) {
        if (f.type === 'select') expect((f.options ?? []).length, `${spec.id}.${f.key} has no options`).toBeGreaterThan(0);
        expect(f.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('aliases never collide across kinds and never shadow a kind id', () => {
    const seen = new Map<string, string>();
    for (const spec of ASSET_KINDS) {
      for (const a of spec.aliases) {
        expect(ITEM_KINDS as readonly string[]).not.toContain(a);
        expect(seen.get(a), `alias "${a}" claimed by ${seen.get(a)} and ${spec.id}`).toBeUndefined();
        seen.set(a, spec.id);
      }
    }
  });

  it('creatable kinds all declare at least one mode; system kinds none', () => {
    for (const spec of ASSET_KINDS) {
      if (spec.create !== null) expect(spec.create.modes.length).toBeGreaterThan(0);
      if (spec.family === 'system') expect(spec.create).toBeNull();
    }
    const ids = creatableKinds().map((s) => s.id);
    for (const required of ['tool', 'presentation', 'video', 'code', 'data', 'design', 'flow', 'notebook', 'styleguide', 'conversation', 'meeting', 'monitor', 'url']) {
      expect(ids).toContain(required);
    }
  });

  it('playbooks and tickets are not reclassifiable; everything else is', () => {
    const ids = reclassifiableKinds().map((s) => s.id);
    expect(ids).not.toContain('playbook');
    expect(ids).not.toContain('ticket');
    expect(ids.length).toBe(ITEM_KINDS.length - 2);
  });
});

describe('normalizeKind — the full app\'s words read as Lite kinds', () => {
  const cases: Array<[string, string]> = [
    ['presentation', 'presentation'],
    ['slides', 'presentation'],
    ['data-source', 'tool'],
    ['web-monitor', 'monitor'],
    ['style-guide', 'styleguide'],
    ['chatbot-conversation', 'conversation'],
    ['journey-map', 'journey'],
    ['html', 'document'],
    ['pdf', 'document'],
    ['generated-document', 'document'],
    ['spreadsheet', 'data'],
    ['screenshot', 'image'],
    ['image-file', 'image'],
    ['recording', 'video'],
    ['wiser-meeting', 'meeting'],
    ['recorder-transcript', 'transcript'],
    ['file', 'other'],
    ['ipynb', 'notebook'],
    ['flowsource', 'flow'],
    ['figma', 'design'],
    ['mcp', 'tool'],
    ['Presentation', 'presentation'],
  ];
  for (const [raw, kind] of cases) {
    it(`${raw} → ${kind}`, () => {
      expect(normalizeKind(raw)).toBe(kind);
    });
  }
  it('passes Lite ids through and maps garbage to other', () => {
    for (const k of ITEM_KINDS) expect(normalizeKind(k)).toBe(k);
    expect(normalizeKind('')).toBe('other');
    expect(normalizeKind(undefined)).toBe('other');
    expect(normalizeKind(42)).toBe('other');
    expect(normalizeKind('nonsense-kind')).toBe('other');
  });
});

describe('inferKindFromFile — a file says what it is', () => {
  const cases: Array<[string, string, string]> = [
    ['deck.pptx', '', 'presentation'],
    ['deck.key', '', 'presentation'],
    ['talk.pdf', 'application/pdf', 'document'],
    ['notes.md', 'text/markdown', 'document'],
    ['script.py', '', 'code'],
    ['app.ts', '', 'code'],
    ['rows.csv', 'text/csv', 'data'],
    ['rows.xlsx', '', 'data'],
    ['config.json', 'application/json', 'data'],
    ['analysis.ipynb', '', 'notebook'],
    ['mock.fig', '', 'design'],
    ['art.psd', '', 'design'],
    ['flowsource_abc123.json', 'application/json', 'flow'],
    ['photo.HEIC', '', 'image'],
    ['clip.mp4', 'video/mp4', 'video'],
    ['voice.m4a', '', 'audio'],
    ['captions.vtt', '', 'transcript'],
    ['bundle.zip', 'application/zip', 'other'],
    ['', 'image/png', 'image'],
    ['', 'text/plain', 'document'],
    ['', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'presentation'],
    ['', '', 'other'],
  ];
  for (const [name, type, kind] of cases) {
    it(`${name || '(no name)'} ${type || '(no mime)'} → ${kind}`, () => {
      expect(inferKindFromFile({ name, type })).toBe(kind);
    });
  }
  it('inferKindFromMime keeps the pre-ADR-098 answers for the classic mimes', () => {
    expect(inferKindFromMime('image/png')).toBe('image');
    expect(inferKindFromMime('audio/mpeg')).toBe('audio');
    expect(inferKindFromMime('video/mp4')).toBe('video');
    expect(inferKindFromMime('application/pdf')).toBe('document');
    expect(inferKindFromMime('text/plain')).toBe('document');
    expect(inferKindFromMime('application/octet-stream')).toBe('other');
  });
});

describe('sniffJsonKind — the shapes the full app recognises', () => {
  it('spots a notebook, a style guide, a conversation, a journey, a flow', () => {
    expect(sniffJsonKind('{"cells":[],"nbformat":4}')).toBe('notebook');
    expect(sniffJsonKind('{"colors":{"a":"#fff"},"typography":{}}')).toBe('styleguide');
    expect(sniffJsonKind('{"messages":[{"role":"user","content":"hi"}]}')).toBe('conversation');
    expect(sniffJsonKind('{"journeyData":{"persona":{}}}')).toBe('journey');
    expect(sniffJsonKind('{"trees":{"main":{"steps":[]}}}')).toBe('flow');
  });
  it('returns null for plain data, arrays of scalars, and non-JSON', () => {
    expect(sniffJsonKind('{"rows":[1,2,3]}')).toBeNull();
    expect(sniffJsonKind('[1,2,3]')).toBeNull();
    expect(sniffJsonKind('name,email\nada,a@b.c')).toBeNull();
    expect(sniffJsonKind('{"messages":["hi"]}')).toBeNull();
  });
});

describe('labels, fields, typed keys', () => {
  it('names the kinds the way the picker does', () => {
    expect(kindLabel('presentation')).toBe('Slides');
    expect(kindLabel('url')).toBe('Web link');
    expect(kindLabel('other')).toBe('File');
    expect(kindLabel('not-a-kind')).toBe('Other');
    expect(kindSpec('not-a-kind').id).toBe('other');
  });
  it('typed keys are exactly the field keys', () => {
    expect(typedMetadataKeys('tool')).toEqual(new Set(kindFields('tool').map((f) => f.key)));
    expect(typedMetadataKeys('playbook').size).toBe(0);
  });
});
