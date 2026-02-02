/**
 * Memory Storage - In-memory storage adapter
 */
import type { StorageAdapter } from './adapter.js';

export class MemoryStorage implements StorageAdapter {
  private data: Map<string, unknown> = new Map();

  async get<T>(key: string): Promise<T | null> {
    const value = this.data.get(key);
    return (value as T) ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }

  async list(prefix?: string): Promise<string[]> {
    const keys: string[] = [];
    for (const key of this.data.keys()) {
      if (!prefix || key.startsWith(prefix)) {
        keys.push(key);
      }
    }
    return keys;
  }

  async has(key: string): Promise<boolean> {
    return this.data.has(key);
  }

  async clear(): Promise<void> {
    this.data.clear();
  }

  async close(): Promise<void> {
    // No-op for memory storage
  }

  /**
   * Get the number of stored items
   */
  size(): number {
    return this.data.size;
  }
}
