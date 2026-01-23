/**
 * File Storage - File-based storage adapter
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import type { StorageAdapter } from './adapter.js';

export class FileStorage implements StorageAdapter {
  private basePath: string;
  private cache: Map<string, unknown> = new Map();
  private dirty: Set<string> = new Set();
  private flushInterval: NodeJS.Timeout | null = null;

  constructor(basePath: string, autoFlushMs = 5000) {
    this.basePath = basePath;

    // Start auto-flush timer
    if (autoFlushMs > 0) {
      this.flushInterval = setInterval(() => this.flush(), autoFlushMs);
    }
  }

  async init(): Promise<void> {
    // Ensure directory exists
    await fs.mkdir(this.basePath, { recursive: true });

    // Load existing data into cache
    try {
      const files = await fs.readdir(this.basePath);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const key = file.slice(0, -5); // Remove .json
          const filePath = path.join(this.basePath, file);
          const content = await fs.readFile(filePath, 'utf-8');
          this.cache.set(this.decodeKey(key), JSON.parse(content));
        }
      }
      console.log(`[FileStorage] Loaded ${this.cache.size} items from ${this.basePath}`);
    } catch (error) {
      // Directory might not exist yet, that's OK
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async get<T>(key: string): Promise<T | null> {
    return (this.cache.get(key) as T) ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.cache.set(key, value);
    this.dirty.add(key);
  }

  async delete(key: string): Promise<boolean> {
    const existed = this.cache.has(key);
    this.cache.delete(key);
    this.dirty.delete(key);

    // Delete file
    try {
      const filePath = this.getFilePath(key);
      await fs.unlink(filePath);
    } catch {
      // File might not exist
    }

    return existed;
  }

  async list(prefix?: string): Promise<string[]> {
    const keys: string[] = [];
    for (const key of this.cache.keys()) {
      if (!prefix || key.startsWith(prefix)) {
        keys.push(key);
      }
    }
    return keys;
  }

  async has(key: string): Promise<boolean> {
    return this.cache.has(key);
  }

  async clear(): Promise<void> {
    this.cache.clear();
    this.dirty.clear();

    // Delete all files
    try {
      const files = await fs.readdir(this.basePath);
      for (const file of files) {
        if (file.endsWith('.json')) {
          await fs.unlink(path.join(this.basePath, file));
        }
      }
    } catch {
      // Directory might not exist
    }
  }

  async close(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    await this.flush();
  }

  /**
   * Flush dirty items to disk
   */
  async flush(): Promise<void> {
    if (this.dirty.size === 0) return;

    const keysToFlush = [...this.dirty];
    this.dirty.clear();

    for (const key of keysToFlush) {
      const value = this.cache.get(key);
      if (value !== undefined) {
        const filePath = this.getFilePath(key);
        await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
      }
    }

    console.log(`[FileStorage] Flushed ${keysToFlush.length} items`);
  }

  // === Private Methods ===

  private getFilePath(key: string): string {
    const encoded = this.encodeKey(key);
    return path.join(this.basePath, `${encoded}.json`);
  }

  private encodeKey(key: string): string {
    // Replace characters not allowed in filenames
    return key.replace(/[/:*?"<>|]/g, '_');
  }

  private decodeKey(encoded: string): string {
    // For now, just return as-is since we lose info in encoding
    // A proper implementation would use base64 or similar
    return encoded;
  }
}
