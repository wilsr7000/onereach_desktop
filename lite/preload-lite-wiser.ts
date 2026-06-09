/**
 * Dedicated preload for the embedded WISER Playbooks window.
 *
 * Unlike the main `preload-lite.ts` (which exposes the full `window.lite.*`
 * bridge to TRUSTED first-party Lite renderers), this preload exposes a
 * SINGLE, minimal surface — `window.ai` — to the HOSTED WISER web app, and
 * nothing else. No auth, no spaces, no keychain read, no `window.lite`.
 *
 * Why this exists: WISER Playbooks already speaks a `window.ai` chat
 * contract (it runs that way inside the Onereach "Spaces" shell). By
 * providing the same contract here, the embedded Playbooks window runs on
 * the Onereach app's Claude key **without the key ever reaching the page** —
 * the renderer only sends messages; the Claude call happens in the main
 * process (see `ai/main.ts` + `ai/chat.ts`), keyed off the OS keychain.
 *
 * SECURITY: the only capability granted to the hosted page is "make a
 * Claude chat call on the app's key". It cannot read the key, list other
 * channels, or reach any other Lite module. This is a deliberate, narrow
 * widening of the window's previous no-preload posture, scoped to exactly
 * what the product requires (embedded Playbooks using the app's token).
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { WISER_AI_CHANNELS } from './ai/wiser-bridge-channels.js';

// ─── envelope unwrapping ─────────────────────────────────────────────────

interface IpcErrorShape {
  code?: string;
  message?: string;
  remediation?: string;
}
type IpcEnvelope<T> = { ok: true; value: T } | { ok: false; error?: IpcErrorShape };

/** Unwrap a `{ ok, value | error }` envelope; throw a real Error on failure. */
function unwrap<T>(env: IpcEnvelope<T>): T {
  if (env !== null && typeof env === 'object' && env.ok === true) {
    return env.value;
  }
  const error = env !== null && typeof env === 'object' && env.ok === false ? env.error : undefined;
  const err = new Error(error?.message ?? 'AI request failed');
  if (error?.code !== undefined) (err as Error & { code?: string }).code = error.code;
  if (error?.remediation !== undefined) {
    (err as Error & { remediation?: string }).remediation = error.remediation;
  }
  throw err;
}

// ─── streaming chunk router (race-safe) ──────────────────────────────────
//
// A SINGLE ipcRenderer.on listener fans every chunk out by requestId.
// Chunks that arrive between `chatStream()` resolving and the page calling
// `onStreamChunk()` are buffered per-request, so none are lost.

interface StreamChunk {
  delta?: string;
  done: boolean;
  finalResult?: unknown;
  error?: IpcErrorShape;
}
interface StreamEntry {
  buffer: StreamChunk[];
  cb: ((chunk: StreamChunk) => void) | null;
}
const streams = new Map<string, StreamEntry>();

function getEntry(requestId: string): StreamEntry {
  let entry = streams.get(requestId);
  if (entry === undefined) {
    entry = { buffer: [], cb: null };
    streams.set(requestId, entry);
  }
  return entry;
}

ipcRenderer.on(
  WISER_AI_CHANNELS.CHAT_STREAM_CHUNK,
  (_event: IpcRendererEvent, payload: unknown) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    const requestId = typeof p['requestId'] === 'string' ? (p['requestId'] as string) : '';
    if (requestId === '') return;
    const chunk: StreamChunk = {
      done: p['done'] === true,
      ...(typeof p['delta'] === 'string' ? { delta: p['delta'] as string } : {}),
      ...(p['finalResult'] !== undefined ? { finalResult: p['finalResult'] } : {}),
      ...(p['error'] !== undefined ? { error: p['error'] as IpcErrorShape } : {}),
    };
    const entry = getEntry(requestId);
    if (entry.cb !== null) {
      entry.cb(chunk);
    } else {
      entry.buffer.push(chunk);
    }
    // Auto-evict once the terminal chunk has been handed off, so a page
    // that forgets to call the cleanup fn can't leak entries forever.
    if (chunk.done && entry.cb !== null) {
      streams.delete(requestId);
    }
  }
);

// ─── window.ai surface ───────────────────────────────────────────────────

interface ChatOptions {
  profile?: string;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
  feature?: string;
}

async function chat(opts: ChatOptions): Promise<unknown> {
  return unwrap(await ipcRenderer.invoke(WISER_AI_CHANNELS.CHAT, opts));
}

async function chatStream(opts: ChatOptions): Promise<{ requestId: string }> {
  const res = unwrap<{ requestId: string }>(
    await ipcRenderer.invoke(WISER_AI_CHANNELS.CHAT_STREAM, opts)
  );
  // Pre-create the entry so chunks racing ahead of onStreamChunk() buffer.
  getEntry(res.requestId);
  return res;
}

function onStreamChunk(requestId: string, cb: (chunk: StreamChunk) => void): () => void {
  const entry = getEntry(requestId);
  entry.cb = cb;
  // Flush anything buffered before the subscription attached.
  if (entry.buffer.length > 0) {
    const pending = entry.buffer;
    entry.buffer = [];
    for (const c of pending) cb(c);
  }
  return () => {
    streams.delete(requestId);
  };
}

// Bonus helpers from the window.ai contract. WISER's chat path doesn't call
// these today, but they're cheap to provide over the same chat channel.
async function complete(prompt: string, opts: Partial<ChatOptions> = {}): Promise<string> {
  const result = (await chat({
    profile: opts.profile ?? 'standard',
    messages: [{ role: 'user', content: String(prompt) }],
    ...opts,
  })) as { content?: string };
  return typeof result.content === 'string' ? result.content : '';
}

async function json(prompt: string, opts: Partial<ChatOptions> = {}): Promise<unknown> {
  const text = await complete(prompt, { ...opts, jsonMode: true });
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  return JSON.parse(fence !== null ? fence[1]! : trimmed);
}

contextBridge.exposeInMainWorld('ai', {
  chat,
  chatStream,
  onStreamChunk,
  complete,
  json,
});
