/**
 * ADR-100 Amendment 1 — the worker-thread runner. A fake worker proves
 * the protocol and the kill timer (a hung conversion becomes
 * CONVERT_TIMEOUT, a crash CONVERT_FAILED, a ConvertError keeps its
 * code); the real worker, bundled here with esbuild the way the build
 * does it, proves the chain end to end.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { WorkerConvertService, parseTimeoutMs } from '../../convert/worker-runner.js';
import { CONVERT_ERROR_CODES } from '../../convert/errors.js';
import { DEFAULT_CONVERT_TIMEOUT_MS, MAX_CONVERT_TIMEOUT_MS, MARKUP_INPUT_BYTES } from '../../convert/types.js';
import { workerPathBeside } from '../../mcp/convert-mcp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const liteRoot = path.resolve(here, '../..');

const FAKE_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { req } = workerData;
if (req.input.startsWith('hang')) { for (;;) {} }
if (req.input === 'crash') { throw new Error('boom'); }
if (req.input === 'silent-exit') { process.exit(3); }
if (req.input === 'converr') {
  parentPort.postMessage({ ok: false, error: { code: 'CONVERT_UNKNOWN_STRATEGY', message: 'nope', remediation: 'pick one', context: { a: 1 } } });
} else if (req.input === 'weird-code') {
  parentPort.postMessage({ ok: false, error: { code: 'SOMETHING_ELSE', message: 'odd', remediation: '', context: {} } });
} else {
  parentPort.postMessage({ ok: true, result: { output: req.input.toUpperCase(), from: req.from, to: req.to, mimeType: 'text/plain', steps: [], durationMs: 1, warnings: [], inputBytes: req.input.length, outputBytes: req.input.length } });
}
`;

let dir = '';
let fakeWorker = '';
let realWorker = '';

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-convert-worker-'));
  fakeWorker = path.join(dir, 'fake-worker.cjs');
  fs.writeFileSync(fakeWorker, FAKE_WORKER, 'utf8');
  realWorker = workerPathBeside(dir);
  await build({
    entryPoints: [path.join(liteRoot, 'convert/worker.ts')],
    outfile: realWorker,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    logLevel: 'silent',
  });
}, 60000);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('WorkerConvertService with a fake worker', () => {
  const md = { from: 'md', to: 'html' };
  it('hands the request to the worker and returns its result', async () => {
    const service = new WorkerConvertService({ workerPath: fakeWorker, timeoutMs: 5000 });
    const r = await service.convert({ input: 'hello', ...md });
    expect(r.output).toBe('HELLO');
    expect(r.from).toBe('md');
  });
  it('a conversion that never returns is stopped at the budget with CONVERT_TIMEOUT', async () => {
    const service = new WorkerConvertService({ workerPath: fakeWorker, timeoutMs: 1000 });
    const t0 = performance.now();
    await expect(service.convert({ input: 'hang', ...md })).rejects.toMatchObject({
      code: CONVERT_ERROR_CODES.TIMEOUT,
      context: { from: 'md', to: 'html', timeoutMs: 1000, inputBytes: 4 },
    });
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(4000);
  });
  it('the budget covers handing the input to the thread: a large hung request is still stopped near the budget', async () => {
    const service = new WorkerConvertService({ workerPath: fakeWorker, timeoutMs: 1000 });
    const t0 = performance.now();
    await expect(service.convert({ input: 'hang' + 'x'.repeat(8 * 1024 * 1024), ...md })).rejects.toMatchObject({ code: CONVERT_ERROR_CODES.TIMEOUT });
    expect(performance.now() - t0).toBeLessThan(3000);
  });
  it('a crash and a silent exit both become CONVERT_FAILED with the reason', async () => {
    const service = new WorkerConvertService({ workerPath: fakeWorker, timeoutMs: 5000 });
    await expect(service.convert({ input: 'crash', ...md })).rejects.toMatchObject({ code: CONVERT_ERROR_CODES.FAILED, message: /worker failed: boom/ });
    await expect(service.convert({ input: 'silent-exit', ...md })).rejects.toMatchObject({ code: CONVERT_ERROR_CODES.FAILED, message: /exited with code 3/ });
  });
  it('a ConvertError from the worker keeps its code, remediation and context; an unknown code becomes CONVERT_FAILED', async () => {
    const service = new WorkerConvertService({ workerPath: fakeWorker, timeoutMs: 5000 });
    await expect(service.convert({ input: 'converr', ...md })).rejects.toMatchObject({ code: CONVERT_ERROR_CODES.UNKNOWN_STRATEGY, message: 'nope', remediation: 'pick one', context: { a: 1 } });
    await expect(service.convert({ input: 'weird-code', ...md })).rejects.toMatchObject({ code: CONVERT_ERROR_CODES.FAILED, message: 'odd' });
  });
  it('format, path and size are refused in-process, and the catalog answers in-process', async () => {
    const service = new WorkerConvertService({ workerPath: path.join(dir, 'does-not-exist.cjs'), timeoutMs: 5000, maxInputBytes: 10 });
    await expect(service.convert({ input: 'x', from: 'nope', to: 'md' })).rejects.toMatchObject({ code: CONVERT_ERROR_CODES.UNKNOWN_FORMAT });
    await expect(service.convert({ input: 'x', from: 'md', to: 'code' })).rejects.toMatchObject({ code: CONVERT_ERROR_CODES.NO_PATH });
    await expect(service.convert({ input: 42 as unknown as string, ...md })).rejects.toMatchObject({ code: CONVERT_ERROR_CODES.INVALID_INPUT });
    await expect(service.convert({ input: 'x'.repeat(11), ...md })).rejects.toMatchObject({ code: CONVERT_ERROR_CODES.TOO_LARGE, context: { max: 10 } });
    expect(service.capabilities().converters.length).toBe(19);
    expect(service.pipeline('csv', 'yaml').steps.map((s) => s.converterId)).toEqual(['csv-to-json', 'json-to-yaml']);
  });
  it('parseTimeoutMs: a whole number of milliseconds between 1 s and 120 s, else the default', () => {
    expect(parseTimeoutMs(undefined)).toBe(DEFAULT_CONVERT_TIMEOUT_MS);
    expect(parseTimeoutMs('')).toBe(DEFAULT_CONVERT_TIMEOUT_MS);
    expect(parseTimeoutMs('abc')).toBe(DEFAULT_CONVERT_TIMEOUT_MS);
    expect(parseTimeoutMs('-5')).toBe(DEFAULT_CONVERT_TIMEOUT_MS);
    expect(parseTimeoutMs('5000')).toBe(5000);
    expect(parseTimeoutMs('10')).toBe(1000);
    expect(parseTimeoutMs('999999')).toBe(MAX_CONVERT_TIMEOUT_MS);
    expect(parseTimeoutMs('2500.7')).toBe(2501);
  });
});

describe('WorkerConvertService with the real worker bundle', () => {
  it('converts through the worker the way the in-process service does', async () => {
    const service = new WorkerConvertService({ workerPath: realWorker, timeoutMs: 10000 });
    const r = await service.convert({ input: '# Hi\n\nsome *text*', from: 'md', to: 'html' });
    expect(r.output).toBe('<h1>Hi</h1>\n<p>some <em>text</em></p>\n');
    expect(r.steps.map((s) => s.converterId)).toEqual(['md-to-html']);
    expect(r.mimeType).toBe('text/html');
  }, 20000);
  it("the review's hostile input answers inside the budget instead of wedging the process", async () => {
    const service = new WorkerConvertService({ workerPath: realWorker, timeoutMs: 8000 });
    const t0 = performance.now();
    const r = await service.convert({ input: '<script'.repeat(150000), from: 'html', to: 'text' });
    expect(typeof r.output).toBe('string');
    expect(performance.now() - t0).toBeLessThan(8000);
  }, 20000);
  it('code-to-html converts AT its declared cap with automatic detection inside the 512 MB worker heap', async () => {
    const service = new WorkerConvertService({ workerPath: realWorker, timeoutMs: 20000 });
    const unit = 'def f(x):\n    return [i * 2 for i in range(x) if i % 3 == 0]  # comment\nclass A(B):\n    v = {"k": 1, "s": "str"}\n';
    const input = unit.repeat(Math.ceil(MARKUP_INPUT_BYTES / Buffer.byteLength(unit))).slice(0, MARKUP_INPUT_BYTES);
    expect(Buffer.byteLength(input)).toBe(MARKUP_INPUT_BYTES);
    const r = await service.convert({ input, from: 'code', to: 'html', strategy: 'fragment' });
    expect(r.steps[0]?.stats).toMatchObject({ language: 'python', autoDetected: true });
    expect(r.outputBytes).toBeGreaterThan(MARKUP_INPUT_BYTES);
  }, 30000);
  it("a converter's cap and a ConvertError cross the worker boundary with their codes", async () => {
    const service = new WorkerConvertService({ workerPath: realWorker, timeoutMs: 10000 });
    await expect(service.convert({ input: 'a'.repeat(MARKUP_INPUT_BYTES + 1), from: 'md', to: 'html' })).rejects.toMatchObject({
      code: CONVERT_ERROR_CODES.TOO_LARGE,
      context: { converterId: 'md-to-html' },
    });
    await expect(service.convert({ input: '{not json', from: 'json', to: 'csv' })).rejects.toMatchObject({ code: CONVERT_ERROR_CODES.FAILED, message: /json-to-csv failed/ });
    await expect(service.convert({ input: '# x', from: 'md', to: 'html', strategy: 'nope' })).rejects.toMatchObject({ code: CONVERT_ERROR_CODES.UNKNOWN_STRATEGY });
  }, 20000);
});
