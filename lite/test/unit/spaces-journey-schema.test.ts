/**
 * ADR-072 — the journey-map contract published to the (:Schema) registry.
 *
 * A journey written by Lite has to open in the Journey Map Builder, and
 * one written by the Builder has to open in Lite. Nothing enforces that
 * at the type level: they are separate codebases writing the same graph.
 * The registry entry IS the shared contract, and it is registered by a
 * best-effort call nothing has tested — not this one, and not the
 * checklist / access-role / version registrations beside it.
 *
 * Best-effort is the risk, not the reason to skip it: a schema write
 * that silently swallows its own failure is exactly the kind of code
 * that stops running and never tells anyone. So this pins that it runs,
 * what it says, and that a registry outage still cannot take a boot down
 * with it.
 */

import { describe, it, expect } from 'vitest';
import { SdkSpacesClient, CYPHER, type SpacesQueryFn } from '../../spaces/sdk-client.js';

interface Call {
  cypher: string;
  parameters: Record<string, unknown>;
}

function stub(opts: { fail?: boolean } = {}): { fn: SpacesQueryFn; calls: Call[] } {
  const calls: Call[] = [];
  const fn: SpacesQueryFn = async (cypher, parameters) => {
    calls.push({ cypher, parameters: (parameters ?? {}) as Record<string, unknown> });
    if (opts.fail === true) throw new Error('Edison returned 502');
    return [];
  };
  return { fn, calls };
}

const journeyCall = (calls: Call[]): Call | undefined =>
  calls.find((c) => c.cypher.includes("MERGE (js:Schema {entity: 'Journey'})"));

describe('registering the journey contract', () => {
  it('merges a single :Schema node — re-running a boot does not fork the entry', () => {
    // MERGE, never CREATE: every boot calls this, and a CREATE would
    // leave one Schema node per launch for readers to disagree over.
    expect(CYPHER.ENSURE_JOURNEY_SCHEMA).toContain("MERGE (js:Schema {entity: 'Journey'})");
    expect(CYPHER.ENSURE_JOURNEY_SCHEMA).not.toContain('CREATE (js');
  });

  it('writes the doc, the property list and a timestamp', async () => {
    const s = stub();
    await new SdkSpacesClient({ query: s.fn }).ensureJourneySchema();
    const call = journeyCall(s.calls);
    expect(call, 'ensureJourneySchema issued no query').toBeDefined();
    expect(Object.keys(call?.parameters ?? {}).sort()).toEqual(
      expect.arrayContaining(['journeyDoc', 'journeyProps', 'now'])
    );
    expect(typeof call?.parameters['journeyDoc']).toBe('string');
    expect(new Date(String(call?.parameters['now'])).toString()).not.toBe('Invalid Date');
  });

  it('describes a journey as an ordinary Space asset, not a private store', async () => {
    const s = stub();
    await new SdkSpacesClient({ query: s.fn }).ensureJourneySchema();
    const doc = String(journeyCall(s.calls)?.parameters['journeyDoc']);
    // The whole point of ADR-072: journeys live in NEON like every other
    // asset, so they inherit visibility, versions and download.
    expect(doc).toContain("(:Asset {type: 'journey'})");
    expect(doc).toContain('BELONGS_TO');
    expect(doc).toContain('Space');
  });

  it('tells another writer the markdown grammar Lite parses back', async () => {
    const s = stub();
    await new SdkSpacesClient({ query: s.fn }).ensureJourneySchema();
    const doc = String(journeyCall(s.calls)?.parameters['journeyDoc']);
    // `## N. Name` is what the journey tile turns into its stage flow. A
    // Builder that writes any other heading shape produces a journey
    // that opens blank in Lite, so the contract has to state it.
    expect(doc).toContain('## N. Name');
    expect(doc).toContain('High|Medium|Low');
    for (const field of ['action', 'emotion', 'thought', 'agent opportunity']) {
      expect(doc.toLowerCase()).toContain(field);
    }
  });

  it('advertises the properties a reader can rely on', async () => {
    const s = stub();
    await new SdkSpacesClient({ query: s.fn }).ensureJourneySchema();
    const props = journeyCall(s.calls)?.parameters['journeyProps'];
    expect(Array.isArray(props)).toBe(true);
    expect(props).toEqual(
      expect.arrayContaining(['id', 'type', 'name', 'description', 'content', 'updatedAt'])
    );
  });

  it('a registry outage never fails the boot that called it', async () => {
    const s = stub({ fail: true });
    // spaces/main.ts fires this un-awaited during init; an unhandled
    // rejection here would surface as a boot-time crash report.
    await expect(new SdkSpacesClient({ query: s.fn }).ensureJourneySchema()).resolves.toBeUndefined();
    expect(journeyCall(s.calls)).toBeDefined(); // it did try
  });
});
