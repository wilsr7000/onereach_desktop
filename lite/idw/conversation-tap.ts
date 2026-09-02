/**
 * Third-party conversation capture — the Electron glue (2026-09-01).
 *
 * Attaches a DevTools-protocol network tap to an external-bot tab and
 * feeds the pure engine in `conversation-capture.ts`; the engine's sink
 * writes transcripts into the provider's Space through the Spaces API.
 *
 * Why the DevTools protocol: Lite's tab views carry NO preload by
 * design (ADR-038 — third-party pages must never reach window.lite).
 * `webContents.debugger` observes request bodies and response bodies
 * from the MAIN process; the page is handed nothing. Electron shows no
 * "being debugged" bar for this (that is a Chrome-only UI).
 *
 * Privacy contract:
 *   - capture is per-bot opt-in/out (`IdwEntry.archiveConversations`,
 *     default ON for the known providers — the user asked for
 *     automatic archiving), never for `custom` bots;
 *   - only conversation-turn requests are decoded (the engine's URL
 *     tests); everything else on the wire is ignored, never logged;
 *   - the transcript goes ONLY to the provider's own
 *     "<Provider> Conversations" Space, the same one the full app uses.
 *
 * Memory export: the providers expose their "memory" only through
 * settings pages, not APIs. `exportProviderMemory()` opens a hidden
 * view on the bot's own partition (so the user's session applies),
 * loads the memory page, reads its visible text via the protocol
 * (`Runtime.evaluate` — still no preload), and files it as a text asset
 * in the same Space. Best-effort by construction: selectors on those
 * pages are theirs to change, so an unrecognized page reports "nothing
 * found" honestly instead of filing an empty note.
 *
 * @internal
 */

import { BrowserWindow, WebContentsView, type WebContents } from 'electron';
import { getLoggingApi } from '../logging/api.js';
import { getSpacesApi } from '../spaces/api.js';
import { IDW_EVENTS } from './events.js';
import type { Space } from '../spaces/types.js';
import {
  ConversationCaptureEngine,
  PROVIDER_SPACES,
  conversationMarkdown,
  conversationTitle,
  decodeRequest,
  decodeResponse,
  isConversationRequest,
  providerForBotType,
  type CaptureConversation,
  type CaptureProvider,
  type ConversationSink,
} from './conversation-capture.js';

/** Idle conversations are forgotten after this; their archives remain. */
const CONVERSATION_TTL_MS = 6 * 60 * 60 * 1000;
/** Response bodies larger than this are skipped (a reply is never this big; a file is). */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// ─── The Spaces sink ─────────────────────────────────────────────────

const spaceIdByProvider = new Map<CaptureProvider, string>();

/**
 * The provider's Space — found by name (the full app's contract) or
 * created with the full app's icon/colour so both apps converge on ONE
 * Space per provider.
 */
async function providerSpaceId(provider: CaptureProvider): Promise<string | null> {
  const cached = spaceIdByProvider.get(provider);
  if (cached !== undefined) return cached;
  const cfg = PROVIDER_SPACES[provider];
  const spaces = getSpacesApi();
  const existing: Space | undefined = (await spaces.listSpaces()).find(
    (s) => s.name.trim().toLowerCase() === cfg.spaceName.toLowerCase()
  );
  if (existing !== undefined) {
    spaceIdByProvider.set(provider, existing.id);
    return existing.id;
  }
  const created = await spaces.createSpace({ name: cfg.spaceName, color: cfg.color, iconKey: 'message-square' });
  spaceIdByProvider.set(provider, created.id);
  return created.id;
}

/** Writes each reply's full transcript in place — one asset per conversation. */
export const spacesSink: ConversationSink = {
  async save(conv: CaptureConversation): Promise<string | null> {
    const log = getLoggingApi();
    try {
      const spaceId = await providerSpaceId(conv.provider);
      if (spaceId === null) return null;
      const spaces = getSpacesApi();
      const content = conversationMarkdown(conv);
      const description = `${conv.provider} · ${conv.exchangeCount} exchange${conv.exchangeCount === 1 ? '' : 's'}`;
      if (conv.savedItemId !== null) {
        try {
          await spaces.items.update(conv.savedItemId, { title: conversationTitle(conv), content, description });
          return conv.savedItemId;
        } catch {
          // The archive may have been deleted in Lite since the last turn —
          // fall through and file a fresh one rather than dropping the turn.
        }
      }
      const created = await spaces.items.create({
        spaceId,
        title: conversationTitle(conv),
        kind: 'transcript',
        content,
        description,
        metadata: {
          source: 'lite-conversation-capture',
          aiService: conv.provider,
          conversationId: conv.externalId ?? conv.key,
          model: conv.model ?? '',
          tags: ['ai-conversation', conv.provider.toLowerCase()],
        },
      });
      log.event(IDW_EVENTS.CONVERSATION_ARCHIVE_FINISH, { provider: conv.provider, itemId: created.id, exchanges: conv.exchangeCount });
      return created.id;
    } catch (err) {
      log.warn('idw', 'conversation archive failed', {
        provider: conv.provider,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  },
};

let engine: ConversationCaptureEngine | null = null;
function getEngine(): ConversationCaptureEngine {
  if (engine === null) engine = new ConversationCaptureEngine(spacesSink);
  return engine;
}

/** @internal — tests swap the sink. */
export function _setConversationEngineForTesting(next: ConversationCaptureEngine | null): void {
  engine = next;
}

// ─── The tap ─────────────────────────────────────────────────────────

interface PendingRequest {
  url: string;
  method: string;
  postData: string | undefined;
  isTurn: boolean;
}

/**
 * Start observing a bot tab's conversation traffic. Returns the stop
 * function; call it before the webContents closes. No-op (and returns
 * a no-op stop) for providers the engine doesn't know.
 */
export function attachConversationTap(webContents: WebContents, botType: string | undefined, tabId: string): () => void {
  const provider = providerForBotType(botType);
  if (provider === null) return (): void => undefined;
  const log = getLoggingApi();
  const dbg = webContents.debugger;
  const pending = new Map<string, PendingRequest>();

  try {
    if (!dbg.isAttached()) dbg.attach('1.3');
    void dbg.sendCommand('Network.enable', { maxResourceBufferSize: MAX_BODY_BYTES, maxTotalBufferSize: MAX_BODY_BYTES * 4 });
  } catch (err) {
    log.warn('idw', 'conversation tap could not attach', { tabId, provider, error: err instanceof Error ? err.message : String(err) });
    return (): void => undefined;
  }

  const onMessage = (_event: unknown, method: string, params: Record<string, unknown>): void => {
    try {
      if (method === 'Network.requestWillBeSent') {
        const request = params['request'] as { url: string; method: string; postData?: string } | undefined;
        const requestId = params['requestId'] as string;
        if (request === undefined) return;
        const isTurn = isConversationRequest(provider, request.url, request.method);
        if (!isTurn) return; // never retain non-conversation traffic
        pending.set(requestId, { url: request.url, method: request.method, postData: request.postData, isTurn });
        const decoded = decodeRequest(provider, request.url, request.postData);
        getEngine().prompt(provider, decoded);
      } else if (method === 'Network.loadingFinished') {
        const requestId = params['requestId'] as string;
        const req = pending.get(requestId);
        if (req === undefined) return;
        pending.delete(requestId);
        void dbg
          .sendCommand('Network.getResponseBody', { requestId })
          .then((result: { body: string; base64Encoded: boolean }) => {
            const body = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
            if (body.length > MAX_BODY_BYTES) return;
            const decoded = decodeResponse(provider, req.url, body);
            return getEngine().response(provider, decoded);
          })
          .catch(() => {
            /* body gone (navigation) — the next turn re-saves the full transcript */
          });
      } else if (method === 'Network.loadingFailed') {
        pending.delete(params['requestId'] as string);
      }
    } catch (err) {
      log.warn('idw', 'conversation tap message failed', { tabId, provider, error: err instanceof Error ? err.message : String(err) });
    }
  };
  dbg.on('message', onMessage);
  const onDetach = (): void => {
    pending.clear();
  };
  dbg.on('detach', onDetach);
  log.event(IDW_EVENTS.CONVERSATION_TAP_START, { tabId, provider });

  return (): void => {
    try {
      dbg.removeListener('message', onMessage);
      dbg.removeListener('detach', onDetach);
      if (dbg.isAttached()) dbg.detach();
    } catch {
      /* already gone */
    }
    pending.clear();
    getEngine().sweep(CONVERSATION_TTL_MS);
  };
}

// ─── Memory export ───────────────────────────────────────────────────

/**
 * Where each provider shows the memory it keeps about the user. These
 * are settings pages, not APIs; verified 2026-09-01 and theirs to
 * change — an unrecognized page reports "nothing found".
 */
export const MEMORY_PAGES: Record<CaptureProvider, { url: string; hint: string } | null> = {
  ChatGPT: { url: 'https://chatgpt.com/#settings/Personalization', hint: 'Settings → Personalization → Memory → Manage' },
  Claude: { url: 'https://claude.ai/settings/memory', hint: 'Settings → Memory' },
  Gemini: { url: 'https://gemini.google.com/saved-info', hint: 'Saved info' },
  Grok: { url: 'https://grok.com/?_s=settings#memory', hint: 'Settings → Data controls → Memory' },
  Perplexity: null,
};

export interface MemoryExportResult {
  ok: boolean;
  provider: CaptureProvider;
  itemId?: string;
  chars?: number;
  reason?: string;
}

/** The page's visible text — evaluated over the protocol, not via a preload. */
async function visibleText(webContents: WebContents): Promise<string> {
  const dbg = webContents.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  const result = (await dbg.sendCommand('Runtime.evaluate', {
    expression:
      "(() => { const main = document.querySelector('main') || document.body; return (main.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim(); })()",
    returnByValue: true,
  })) as { result?: { value?: unknown } };
  const value = result.result?.value;
  return typeof value === 'string' ? value : '';
}

/**
 * Export what a provider remembers about the user into its Space.
 * Runs in a hidden view on the bot's OWN partition so the signed-in
 * session applies; the view is closed afterwards.
 */
export async function exportProviderMemory(botType: string | undefined, partition: string): Promise<MemoryExportResult> {
  const provider = providerForBotType(botType);
  if (provider === null) return { ok: false, provider: 'ChatGPT', reason: 'Not a known provider.' };
  const page = MEMORY_PAGES[provider];
  if (page === null) return { ok: false, provider, reason: `${provider} does not expose a memory page to export.` };
  const log = getLoggingApi();

  const host = new BrowserWindow({ show: false, width: 1100, height: 900 });
  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, partition },
  });
  host.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1100, height: 900 });
  try {
    await view.webContents.loadURL(page.url);
    // Settings panes render after load; give the SPA a moment, twice.
    let text = '';
    for (const wait of [1500, 2500]) {
      await new Promise((r) => setTimeout(r, wait));
      text = await visibleText(view.webContents);
      if (text.length > 200) break;
    }
    if (text.length < 40) {
      return { ok: false, provider, reason: `Nothing readable at ${page.hint} — sign in to ${provider} in its tab and try again.` };
    }
    const spaceId = await providerSpaceId(provider);
    if (spaceId === null) return { ok: false, provider, reason: 'Could not open the provider Space.' };
    const stamp = new Date().toISOString().slice(0, 10);
    const created = await getSpacesApi().items.create({
      spaceId,
      title: `${provider} memory export — ${stamp}`,
      kind: 'text',
      content: `# ${PROVIDER_SPACES[provider].icon} ${provider} memory\n\n_Exported from ${page.hint} on ${stamp}._\n\n${text}`,
      description: `What ${provider} remembers about you, as of ${stamp}`,
      metadata: { source: 'lite-memory-export', aiService: provider, exportedAt: new Date().toISOString(), tags: ['ai-memory', provider.toLowerCase()] },
    });
    log.event(IDW_EVENTS.MEMORY_EXPORT_FINISH, { provider, itemId: created.id, chars: text.length });
    return { ok: true, provider, itemId: created.id, chars: text.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('idw', 'memory export failed', { provider, error: message });
    return { ok: false, provider, reason: message };
  } finally {
    try {
      view.webContents.close();
    } catch {
      /* best-effort */
    }
    host.destroy();
  }
}
