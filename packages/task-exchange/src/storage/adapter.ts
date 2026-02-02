/**
 * Storage Adapter - Abstract interface for persistence
 */

export interface StorageAdapter {
  /**
   * Get a value by key
   */
  get<T>(key: string): Promise<T | null>;

  /**
   * Set a value
   */
  set<T>(key: string, value: T): Promise<void>;

  /**
   * Delete a key
   */
  delete(key: string): Promise<boolean>;

  /**
   * List all keys with a prefix
   */
  list(prefix?: string): Promise<string[]>;

  /**
   * Check if a key exists
   */
  has(key: string): Promise<boolean>;

  /**
   * Clear all data
   */
  clear(): Promise<void>;

  /**
   * Close/cleanup the storage
   */
  close(): Promise<void>;
}
