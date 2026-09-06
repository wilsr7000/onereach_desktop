/**
 * mirrorSpaceToGsx — a Space made in Lite becomes a Designer bot too
 * (ADR-092). Driven with a fake port + fake client; no graph, no GSX.
 */
import { describe, it, expect } from 'vitest';
import { mirrorSpaceToGsx, describeMirrorOutcome, type GsxSpaceMirrorDeps } from '../../spaces/gsx-space-mirror.js';
import { GsxFlowsError, type GsxFlowsPort } from '../../spaces/gsx-flows-port.js';

function makeDeps(over: {
  createBot?: ((input: { label: string; description: string }) => Promise<{ id: string }>) | 'absent';
  stamp?: boolean | Error;
  signedOut?: boolean;
} = {}): { deps: GsxSpaceMirrorDeps; rec: { created: Array<{ label: string; description: string }>; stamps: Array<[string, string, string]>; spans: string[]; warns: string[] } } {
  const rec = { created: [] as Array<{ label: string; description: string }>, stamps: [] as Array<[string, string, string]>, spans: [] as string[], warns: [] as string[] };
  const fallback: NonNullable<GsxFlowsPort['createBot']> = async (input) => { rec.created.push(input); return { id: 'bot-1' }; };
  const createBot: NonNullable<GsxFlowsPort['createBot']> = typeof over.createBot === 'function' ? over.createBot : fallback;
  const port: Pick<GsxFlowsPort, 'createBot'> | null =
    over.signedOut === true ? null : over.createBot === 'absent' ? {} : { createBot };
  const deps: GsxSpaceMirrorDeps = {
    port,
    client: {
      async setSpaceGsxBot(spaceId, botId, label) {
        if (over.stamp instanceof Error) throw over.stamp;
        rec.stamps.push([spaceId, botId, label]);
        return over.stamp ?? true;
      },
    },
    log: {
      start: (name) => {
        rec.spans.push(`${name}.start`);
        return { finish: () => rec.spans.push(`${name}.finish`), fail: () => rec.spans.push(`${name}.fail`) };
      },
      warn: (_c, m) => { rec.warns.push(m); },
    },
  };
  return { deps, rec };
}

const space = { id: 'space-1', name: 'Customer Care', description: 'Support flows' };

describe('mirrorSpaceToGsx', () => {
  it('creates the bot with the Space’s name and description, then stamps the Space with it', async () => {
    const { deps, rec } = makeDeps();
    const r = await mirrorSpaceToGsx(deps, space);
    expect(r).toEqual({ mirrored: true, botId: 'bot-1', stamped: true });
    expect(rec.created).toEqual([{ label: 'Customer Care', description: 'Support flows' }]);
    expect(rec.stamps).toEqual([['space-1', 'bot-1', 'Customer Care']]);
    expect(rec.spans).toEqual(['spaces.gsxBot.create.start', 'spaces.gsxBot.create.finish']);
    expect(describeMirrorOutcome(r)).toBe('also created as a GSX space in Designer');
  });

  it('signed out (no port) → reported, nothing attempted', async () => {
    const { deps, rec } = makeDeps({ signedOut: true });
    const r = await mirrorSpaceToGsx(deps, space);
    expect(r).toEqual({ mirrored: false, reason: 'signed-out' });
    expect(rec.created).toHaveLength(0);
    expect(rec.spans).toHaveLength(0);
    expect(describeMirrorOutcome(r)).toContain('sign in');
  });

  it('a port without createBot → unsupported, quietly', async () => {
    const { deps } = makeDeps({ createBot: 'absent' });
    expect(await mirrorSpaceToGsx(deps, space)).toEqual({ mirrored: false, reason: 'unsupported' });
  });

  it('the hub refusing the token (401) reads as signed-out; any other failure as failed — the span fails either way', async () => {
    const refused = makeDeps({ createBot: async () => { throw new GsxFlowsError('needs the user token', 401); } });
    const r1 = await mirrorSpaceToGsx(refused.deps, space);
    expect(r1).toMatchObject({ mirrored: false, reason: 'signed-out' });
    expect(refused.rec.spans).toEqual(['spaces.gsxBot.create.start', 'spaces.gsxBot.create.fail']);

    const down = makeDeps({ createBot: async () => { throw new Error('hub did not answer'); } });
    const r2 = await mirrorSpaceToGsx(down.deps, space);
    expect(r2).toEqual({ mirrored: false, reason: 'failed', error: 'hub did not answer' });
    expect(describeMirrorOutcome(r2)).toContain('Designer did not accept it');
    expect(down.rec.stamps).toHaveLength(0);
  });

  it('a bot that exists but a Space that could not be stamped is reported, not hidden', async () => {
    const notWritable = makeDeps({ stamp: false });
    const r1 = await mirrorSpaceToGsx(notWritable.deps, space);
    expect(r1).toEqual({ mirrored: true, botId: 'bot-1', stamped: false });
    expect(describeMirrorOutcome(r1)).toContain('could not be linked');

    const threw = makeDeps({ stamp: new Error('graph down') });
    const r2 = await mirrorSpaceToGsx(threw.deps, space);
    expect(r2).toEqual({ mirrored: true, botId: 'bot-1', stamped: false });
    expect(threw.rec.warns).toEqual(['gsx space mirror: bot created but the Space could not be stamped']);
    expect(threw.rec.spans).toEqual(['spaces.gsxBot.create.start', 'spaces.gsxBot.create.finish']);
  });
});
