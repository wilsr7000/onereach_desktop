/**
 * Memory-ingest module -- server config store. Per ADR-079.
 *
 * The list of connected agentic-memory MCP servers lives in the user's
 * OAGI KV (collection `lite-memory-config`, key `servers`) -- the same
 * account-scoped store the rest of Lite's config rides, so the list
 * follows the user across devices exactly like their Neon settings.
 *
 * The KV surface is injected so unit tests run against a plain Map.
 * Production call sites pass `getKVApi()` from `lite/kv/api.js`.
 */

import { randomUUID } from 'node:crypto';
import type { MemoryServerConfig } from './types.js';

/** The slice of the KV api this store needs. */
export interface MemoryConfigKV {
  get(collection: string, key: string): Promise<unknown | null>;
  set(collection: string, key: string, value: unknown): Promise<void>;
}

export const MEMORY_CONFIG_COLLECTION = 'lite-memory-config';
export const MEMORY_CONFIG_KEY = 'servers';

interface StoredShape {
  servers: MemoryServerConfig[];
}

function isServerConfig(v: unknown): v is MemoryServerConfig {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    typeof o.url === 'string'
  );
}

/**
 * Read the configured server list. Malformed or absent KV values
 * degrade to an empty list -- a broken config document must never make
 * Settings or the ingest runner unopenable.
 */
export async function listServers(
  kv: MemoryConfigKV
): Promise<MemoryServerConfig[]> {
  let raw: unknown;
  try {
    raw = await kv.get(MEMORY_CONFIG_COLLECTION, MEMORY_CONFIG_KEY);
  } catch {
    return [];
  }
  if (typeof raw !== 'object' || raw === null) return [];
  const servers = (raw as StoredShape).servers;
  if (!Array.isArray(servers)) return [];
  return servers.filter(isServerConfig);
}

export interface AddServerInput {
  name: string;
  url: string;
  apiKey?: string;
  toolName?: string;
}

/**
 * Validate + append one server. Returns the stored record.
 * Rejects blank name/url and non-http(s) URLs up front so the
 * Settings form gets a message instead of a dead config entry.
 */
export async function addServer(
  kv: MemoryConfigKV,
  input: AddServerInput,
  nowIso: string = new Date().toISOString()
): Promise<MemoryServerConfig> {
  const name = input.name.trim();
  const url = input.url.trim();
  if (name.length === 0) throw new Error('Name is required');
  if (url.length === 0) throw new Error('Server URL is required');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Server URL is not a valid URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Server URL must be http(s)');
  }
  const existing = await listServers(kv);
  if (existing.some((s) => s.url === url)) {
    throw new Error('That server URL is already connected');
  }
  const record: MemoryServerConfig = {
    id: randomUUID(),
    name,
    url,
    createdAt: nowIso,
  };
  const apiKey = input.apiKey?.trim();
  if (apiKey !== undefined && apiKey.length > 0) record.apiKey = apiKey;
  const toolName = input.toolName?.trim();
  if (toolName !== undefined && toolName.length > 0) record.toolName = toolName;
  await kv.set(MEMORY_CONFIG_COLLECTION, MEMORY_CONFIG_KEY, {
    servers: [...existing, record],
  });
  return record;
}

/** Remove one server by id. Unknown ids are a no-op (idempotent). */
export async function removeServer(
  kv: MemoryConfigKV,
  id: string
): Promise<void> {
  const existing = await listServers(kv);
  const next = existing.filter((s) => s.id !== id);
  if (next.length === existing.length) return;
  await kv.set(MEMORY_CONFIG_COLLECTION, MEMORY_CONFIG_KEY, {
    servers: next,
  });
}
