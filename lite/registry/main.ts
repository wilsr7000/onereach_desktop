/**
 * Agent Registry — main-process module (ADR-086): the API over NEON,
 * the IPC surface (one envelope shape, the permission decision in the
 * Cypher), and the window.
 */
import { ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { RegistryApi, RegistryError, configureRegistryApi, getRegistryApi } from './api.js';
import { openRegistryWindow, closeRegistryWindow } from './window.js';
import type { AdmissionPatch, RegistryManagerApi } from './api.js';
import type { RegistryAgentPatch, RegistryListing, RegistryReach, RegistrySearchInput } from './types.js';

export const REGISTRY_IPC = {
  WHO_AM_I: 'lite:registry:whoami',
  CLAIM_FIRST_ADMIN: 'lite:registry:claim-first-admin',
  SET_ADMIN: 'lite:registry:set-admin',
  SEARCH: 'lite:registry:search',
  GET: 'lite:registry:get',
  UPDATE: 'lite:registry:update',
  SET_ENABLED: 'lite:registry:set-enabled',
  LIST_IDWS: 'lite:registry:list-idws',
  LIST_KNOWLEDGE: 'lite:registry:list-knowledge',
  LIST_CAPABILITIES: 'lite:registry:list-capabilities',
  LINK: 'lite:registry:link',
  CREATE_KNOWLEDGE: 'lite:registry:create-knowledge',
  CREATE_CAPABILITY: 'lite:registry:create-capability',
  ADD_ENDPOINT: 'lite:registry:add-endpoint',
  REMOVE_ENDPOINT: 'lite:registry:remove-endpoint',
  CHECKLIST: 'lite:registry:checklist',
  SET_MANUAL_CHECK: 'lite:registry:set-manual-check',
  SET_LISTING: 'lite:registry:set-listing',
  OPEN_WINDOW: 'lite:registry:open-window',
  // ADR-088 — admission checklist
  ADMISSION_GET: 'lite:registry:admission-get',
  ADMISSION_SAVE: 'lite:registry:admission-save',
  ADMISSION_ANALYZE: 'lite:registry:admission-analyze',
  OPEN_EXTERNAL: 'lite:registry:open-external',
  /** main → renderer: select this agent (opened from a Space's agent detail). */
  FOCUS: 'lite:registry:focus',
} as const;

export interface RegistryIpcResult<T> {
  ok: boolean;
  value?: T;
  error?: { code: string; message: string; remediation: string };
}

export interface InitRegistryOptions {
  query: (cypher: string, parameters: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
  viewerId: () => string | null;
  getMainWindow: () => BrowserWindow | null;
  htmlPath: string;
  preloadPath: string;
  logger?: { info: (msg: string, data?: unknown) => void; warn: (msg: string, data?: unknown) => void };
  /** ADR-088 — the shared admission document (KV) and the grading model. */
  kv?: { get(collection: string, key: string): Promise<unknown | null>; set(collection: string, key: string, value: unknown): Promise<void> };
  ai?: { chat(input: { system?: string; messages: Array<{ role: 'user' | 'assistant'; content: string }>; maxTokens?: number }): Promise<{ content: string; model?: string }> };
}

export interface RegistryHandle {
  open(): void;
  api: RegistryManagerApi;
  dispose(): void;
}

function envelope<T>(fn: () => Promise<T>): Promise<RegistryIpcResult<T>> {
  return fn().then(
    (value) => ({ ok: true, value }),
    (err: unknown) => {
      if (err instanceof RegistryError) {
        return { ok: false, error: { code: err.code, message: err.message, remediation: err.remediation } };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: { code: 'REGISTRY_ERROR', message, remediation: 'Try again; if it persists, check the NEON connection in Settings.' } };
    }
  );
}

const s = (v: unknown): string => (typeof v === 'string' ? v : '');

export function initRegistry(opts: InitRegistryOptions): RegistryHandle {
  const built = new RegistryApi({ query: opts.query, viewerId: opts.viewerId, ...(opts.kv !== undefined ? { kv: opts.kv } : {}), ...(opts.ai !== undefined ? { ai: opts.ai } : {}) });
  configureRegistryApi(() => built);
  const api = getRegistryApi();
  void api.ensureAnnotations();

  const handlers: Array<[string, (event: IpcMainInvokeEvent, payload?: Record<string, unknown>) => Promise<unknown>]> = [
    [REGISTRY_IPC.WHO_AM_I, () => envelope(() => api.whoAmI())],
    [REGISTRY_IPC.CLAIM_FIRST_ADMIN, () => envelope(() => api.claimFirstAdmin())],
    [REGISTRY_IPC.SET_ADMIN, (_e, p) => envelope(() => api.setAdmin(s(p?.['personId']), p?.['isAdmin'] === true))],
    [REGISTRY_IPC.SEARCH, (_e, p) => envelope(() => api.search((p?.['input'] ?? {}) as RegistrySearchInput))],
    [REGISTRY_IPC.GET, (_e, p) => envelope(() => api.get(s(p?.['id'])))],
    [REGISTRY_IPC.UPDATE, (_e, p) => envelope(() => api.update(s(p?.['id']), (p?.['patch'] ?? {}) as RegistryAgentPatch))],
    [REGISTRY_IPC.SET_ENABLED, (_e, p) => envelope(() => api.setEnabled(s(p?.['id']), p?.['enabled'] === true))],
    [REGISTRY_IPC.LIST_IDWS, () => envelope(() => api.listIdws())],
    [REGISTRY_IPC.LIST_KNOWLEDGE, () => envelope(() => api.listKnowledgeModels())],
    [REGISTRY_IPC.LIST_CAPABILITIES, () => envelope(() => api.listCapabilities())],
    [
      REGISTRY_IPC.LINK,
      (_e, p) =>
        envelope(() => {
          const kind = s(p?.['kind']);
          if (kind !== 'idw' && kind !== 'knowledge' && kind !== 'capability') {
            throw new RegistryError('REGISTRY_INVALID_INPUT', 'kind must be idw, knowledge or capability.');
          }
          return api.link(s(p?.['id']), kind, s(p?.['targetId']), p?.['on'] !== false);
        }),
    ],
    [REGISTRY_IPC.CREATE_KNOWLEDGE, (_e, p) => envelope(() => api.createKnowledgeModel({ name: s(p?.['name']), description: s(p?.['description']) }))],
    [REGISTRY_IPC.CREATE_CAPABILITY, (_e, p) => envelope(() => api.createCapability({ name: s(p?.['name']), description: s(p?.['description']) }))],
    [
      REGISTRY_IPC.ADD_ENDPOINT,
      (_e, p) =>
        envelope(() =>
          api.addEndpoint(s(p?.['id']), {
            kind: s(p?.['kind']) as RegistryReach,
            url: s(p?.['url']),
            channels: Array.isArray(p?.['channels']) ? (p?.['channels'] as unknown[]).map((c) => String(c)) : [],
          })
        ),
    ],
    [REGISTRY_IPC.REMOVE_ENDPOINT, (_e, p) => envelope(() => api.removeEndpoint(s(p?.['id']), s(p?.['endpointId'])))],
    [REGISTRY_IPC.CHECKLIST, (_e, p) => envelope(() => api.checklist(s(p?.['id'])))],
    [REGISTRY_IPC.SET_MANUAL_CHECK, (_e, p) => envelope(() => api.setManualCheck(s(p?.['id']), s(p?.['checkId']), p?.['value'] === true))],
    [REGISTRY_IPC.SET_LISTING, (_e, p) => envelope(() => api.setListing(s(p?.['id']), s(p?.['listing']) as RegistryListing))],
    [REGISTRY_IPC.ADMISSION_GET, (_e, p) => envelope(() => api.admissionGet(s(p?.['id'])))],
    [REGISTRY_IPC.ADMISSION_SAVE, (_e, p) => envelope(() => api.admissionSave(s(p?.['id']), (p?.['patch'] ?? {}) as AdmissionPatch))],
    [REGISTRY_IPC.ADMISSION_ANALYZE, (_e, p) => envelope(() => api.admissionAnalyze(s(p?.['id'])))],
    [
      REGISTRY_IPC.OPEN_EXTERNAL,
      (_e, p) =>
        envelope(async () => {
          // Only OneReach-hosted pages (the checklist lives on Edison files).
          const url = new URL(s(p?.['url']));
          if (url.protocol !== 'https:' || !/(^|\.)onereach\.ai$/i.test(url.hostname)) {
            throw new RegistryError('REGISTRY_INVALID_INPUT', 'Only https://…onereach.ai pages can be opened from the registry.');
          }
          await shell.openExternal(url.toString());
          return { ok: true as const };
        }),
    ],
    [
      REGISTRY_IPC.OPEN_WINDOW,
      (_e, p) =>
        envelope(async () => {
          const agentId = typeof p?.['agentId'] === 'string' ? (p['agentId'] as string) : '';
          open(agentId.length > 0 ? agentId : undefined);
          return { ok: true as const };
        }),
    ],
  ];
  for (const [channel, handler] of handlers) ipcMain.handle(channel, handler);

  const open = (agentId?: string): void => {
    const win = openRegistryWindow({ parent: opts.getMainWindow(), htmlPath: opts.htmlPath, preloadPath: opts.preloadPath });
    if (agentId === undefined) return;
    // ADR-088: opened from a Space's agent detail — land on that agent.
    const send = (): void => {
      if (!win.isDestroyed()) win.webContents.send(REGISTRY_IPC.FOCUS, { agentId });
    };
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
    else send();
  };

  return {
    open,
    api,
    dispose(): void {
      for (const [channel] of handlers) ipcMain.removeHandler(channel);
      closeRegistryWindow();
    },
  };
}
