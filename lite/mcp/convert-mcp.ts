/**
 * Convert MCP server (ADR-100): the full app's file-conversion agents,
 * migrated to Lite as plain converters and offered to Claude Code /
 * Claude Desktop as tools over stdio.
 *
 *   convert_capabilities  — formats, converters, strategies, reachable pairs
 *   convert_pipeline      — how a (from, to) pair would be converted
 *   convert_text          — do it: text in, text out (+ an optional report)
 *
 * One implementation, not a parallel one: this runs the same
 * ConvertService the app uses, in its own node process with no Electron
 * import (the api.ts wrapper adds spans inside the app; here the run
 * report is the record).
 *
 * Amendment 1: every conversion runs in a worker thread with a kill
 * timer (CONVERT_TIMEOUT_MS, default 20 s) and a heap limit, so one
 * hostile input cannot wedge the server; the worker bundle must sit
 * beside this one or the server refuses to start. HTML output from
 * md-to-html is sanitised by default; the other HTML producers escape
 * their input.
 */

import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ConvertService } from '../convert/service.js';
import { createDefaultRegistry } from '../convert/converters/index.js';
import { ConvertError } from '../convert/errors.js';
import { WorkerConvertService, parseTimeoutMs, type ConvertRunner } from '../convert/worker-runner.js';
import type { ConvertResult } from '../convert/types.js';

export function createService(): ConvertService {
  return new ConvertService({ registry: createDefaultRegistry() });
}

export interface ToolText {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function text(value: unknown): ToolText {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function failure(err: unknown): ToolText {
  if (err instanceof ConvertError) {
    const lines = [`${err.code}: ${err.message}`];
    if (err.remediation.length > 0) lines.push(err.remediation);
    return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
  }
  return { content: [{ type: 'text', text: `CONVERT_FAILED: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
}

/** The run report agents can quote: steps, strategies, sizes, warnings. */
export function report(result: ConvertResult): Record<string, unknown> {
  return {
    from: result.from,
    to: result.to,
    mimeType: result.mimeType,
    steps: result.steps.map((s) => ({ converter: s.converterId, strategy: s.strategy, durationMs: s.durationMs, ...s.stats })),
    inputBytes: result.inputBytes,
    outputBytes: result.outputBytes,
    durationMs: result.durationMs,
    warnings: result.warnings,
  };
}

/** Register the three tools. Exported so tests can drive the handlers. */
export function registerTools(server: McpServer, service: ConvertRunner): void {
  server.registerTool(
    'convert_capabilities',
    {
      description:
        'What the converter can do: every format (with aliases and whether anything reads or writes it), every converter with its strategies, options and input cap, and every reachable (from, to) pair. Start here.',
      inputSchema: {},
    },
    async () => text(service.capabilities())
  );

  server.registerTool(
    'convert_pipeline',
    {
      description: 'How a from → to conversion would run: the converter steps, in order. Useful before converting something large.',
      inputSchema: {
        from: z.string().describe('Source format id or alias (md, markdown, html, txt, csv, json, yaml…)'),
        to: z.string().describe('Target format id or alias'),
      },
    },
    async ({ from, to }) => {
      try {
        return text(service.pipeline(from, to));
      } catch (err) {
        return failure(err);
      }
    }
  );

  server.registerTool(
    'convert_text',
    {
      description:
        'Convert text from one format to another (Markdown, HTML, plain text, CSV/TSV, JSON, YAML, Jupyter, code…). Returns the converted text; add include_report for the steps, sizes and warnings. Limits: 25 MB for the data formats, 8 MB for the tag/marker strippers, 2 MB for the Markdown/HTML/code renderers, and a wall-clock budget per run (CONVERT_TIMEOUT). HTML output: md-to-html is sanitised by default (options.sanitize=false keeps raw HTML — only for Markdown you wrote yourself); treat any HTML made from untrusted input as untrusted.',
      inputSchema: {
        input: z.string().describe('The content to convert, as text'),
        from: z.string().describe('Source format id or alias'),
        to: z.string().describe('Target format id or alias'),
        strategy: z.string().optional().describe('A strategy id of the converter that will run (see convert_capabilities); the default when omitted'),
        options: z.record(z.unknown()).optional().describe('Converter options, e.g. { "indent": 0 } or { "title": "Report" }'),
        include_report: z.boolean().optional().describe('Append a JSON report (steps, strategies, sizes, warnings) after the output'),
      },
    },
    async ({ input, from, to, strategy, options, include_report }) => {
      try {
        const result = await service.convert({ input, from, to, ...(strategy !== undefined ? { strategy } : {}), ...(options !== undefined ? { options } : {}) });
        if (include_report === true) {
          return {
            content: [
              { type: 'text', text: result.output },
              { type: 'text', text: JSON.stringify(report(result), null, 2) },
            ],
          };
        }
        return text(result.output);
      } catch (err) {
        return failure(err);
      }
    }
  );
}

/** The worker bundle esbuild writes beside this file; without it the server refuses to start rather than run unbounded. */
export function workerPathBeside(dir: string): string {
  return path.join(dir, 'convert-worker.js');
}

async function main(): Promise<void> {
  const workerPath = workerPathBeside(__dirname);
  if (!fs.existsSync(workerPath)) {
    throw new Error(`convert-worker.js is missing beside ${path.basename(__filename)} — run npm run lite:build`);
  }
  const timeoutMs = parseTimeoutMs(process.env['CONVERT_TIMEOUT_MS']);
  const server = new McpServer({ name: 'onereach-convert', version: '1.1.0' });
  registerTools(server, new WorkerConvertService({ workerPath, timeoutMs }));
  process.stderr.write(`[convert-mcp] conversions run in a worker thread (${timeoutMs} ms budget, 512 MB heap)\n`);
  await server.connect(new StdioServerTransport());
}

// Only run as a program — imports (tests) get the seams without side effects.
if (process.argv[1] !== undefined && /convert-mcp/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    process.stderr.write(`[convert-mcp] refusing to start: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
