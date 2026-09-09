/**
 * Convert MCP server (ADR-100): the three tools register with the
 * schemas agents need, run the real service, and turn typed errors into
 * legible error envelopes instead of throwing across the transport.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { registerTools, createService, report } from '../../mcp/convert-mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

interface Registered {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

function fakeServer(): { server: McpServer; tools: Map<string, Registered> } {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool: (name: string, meta: { description: string; inputSchema: Record<string, z.ZodTypeAny> }, handler: Registered['handler']) => {
      tools.set(name, { name, description: meta.description, schema: meta.inputSchema, handler });
    },
  } as unknown as McpServer;
  return { server, tools };
}

describe('convert MCP tools', () => {
  const { server, tools } = fakeServer();
  registerTools(server, createService());

  it('registers the three tools with descriptions and typed inputs', () => {
    expect([...tools.keys()].sort()).toEqual(['convert_capabilities', 'convert_pipeline', 'convert_text']);
    const t = tools.get('convert_text') as Registered;
    expect(Object.keys(t.schema).sort()).toEqual(['from', 'include_report', 'input', 'options', 'strategy', 'to']);
    expect(z.object(t.schema).safeParse({ input: 'x', from: 'md', to: 'html' }).success).toBe(true);
    expect(z.object(t.schema).safeParse({ from: 'md', to: 'html' }).success).toBe(false);
    for (const tool of tools.values()) expect(tool.description.length).toBeGreaterThan(20);
  });

  it('convert_text returns the output, and the report when asked', async () => {
    const t = tools.get('convert_text') as Registered;
    const plain = await t.handler({ input: 'a,b\n1,2\n', from: 'csv', to: 'json', options: { indent: 0 } });
    expect(plain.isError).toBeUndefined();
    expect(plain.content[0]?.text).toBe('[{"a":1,"b":2}]');
    const withReport = await t.handler({ input: '# T', from: 'md', to: 'html', strategy: 'standard', include_report: true });
    expect(withReport.content).toHaveLength(2);
    const rep = JSON.parse(withReport.content[1]?.text ?? '{}') as { steps: Array<{ converter: string; strategy: string }> };
    expect(rep.steps[0]).toMatchObject({ converter: 'md-to-html', strategy: 'standard' });
  });

  it('typed errors come back as error envelopes with the code and the remediation', async () => {
    const t = tools.get('convert_text') as Registered;
    const bad = await t.handler({ input: 'x', from: 'md', to: 'pdf' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.text).toMatch(/^CONVERT_UNKNOWN_FORMAT: /);
    expect(bad.content[0]?.text).toMatch(/convert_capabilities/);
    const p = tools.get('convert_pipeline') as Registered;
    const noPath = await p.handler({ from: 'html', to: 'csv' });
    expect(noPath.isError).toBe(true);
    expect(noPath.content[0]?.text).toMatch(/^CONVERT_NO_PATH/);
  });

  it('convert_capabilities and convert_pipeline answer with JSON', async () => {
    const caps = JSON.parse((await (tools.get('convert_capabilities') as Registered).handler({})).content[0]?.text ?? '') as { converters: Array<{ id: string }>; formats: unknown[] };
    expect(caps.converters.map((c) => c.id)).toContain('csv-to-json');
    expect(caps.formats.length).toBeGreaterThan(5);
    const plan = JSON.parse((await (tools.get('convert_pipeline') as Registered).handler({ from: 'markdown', to: 'html' })).content[0]?.text ?? '') as { steps: Array<{ converterId: string }> };
    expect(plan.steps.map((s) => s.converterId)).toEqual(['md-to-html']);
  });

  it('report flattens step stats', async () => {
    const result = await createService().convert({ input: 'a,b\n1,2', from: 'csv', to: 'json' });
    const rep = report(result) as { steps: Array<Record<string, unknown>>; outputBytes: number };
    expect(rep.steps[0]).toMatchObject({ converter: 'csv-to-json', rowCount: 1, columnCount: 2 });
    expect(rep.outputBytes).toBeGreaterThan(0);
  });
});
