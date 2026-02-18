/**
 * Filesystem Mocks
 * Part of the Governed Self-Improving Agent Runtime Testing Infrastructure
 */

import { vi } from 'vitest';

// In-memory file system for testing
const mockFileSystem = new Map();

export const fs = {
  // Sync methods
  readFileSync: vi.fn((path, _options) => {
    if (mockFileSystem.has(path)) {
      return mockFileSystem.get(path);
    }
    const error = new Error(`ENOENT: no such file or directory, open '${path}'`);
    error.code = 'ENOENT';
    throw error;
  }),

  writeFileSync: vi.fn((path, data) => {
    mockFileSystem.set(path, data);
  }),

  existsSync: vi.fn((path) => mockFileSystem.has(path)),

  mkdirSync: vi.fn(),

  readdirSync: vi.fn((path) => {
    const files = [];
    for (const key of mockFileSystem.keys()) {
      if (key.startsWith(path)) {
        const relative = key.slice(path.length + 1);
        const firstPart = relative.split('/')[0];
        if (firstPart && !files.includes(firstPart)) {
          files.push(firstPart);
        }
      }
    }
    return files;
  }),

  unlinkSync: vi.fn((path) => {
    mockFileSystem.delete(path);
  }),

  statSync: vi.fn((path) => {
    if (!mockFileSystem.has(path)) {
      const error = new Error(`ENOENT: no such file or directory, stat '${path}'`);
      error.code = 'ENOENT';
      throw error;
    }
    const content = mockFileSystem.get(path);
    return {
      isDirectory: () => false,
      isFile: () => true,
      size: content ? content.length : 0,
      mtime: new Date(),
      ctime: new Date(),
    };
  }),

  copyFileSync: vi.fn((src, dest) => {
    if (mockFileSystem.has(src)) {
      mockFileSystem.set(dest, mockFileSystem.get(src));
    }
  }),

  renameSync: vi.fn((oldPath, newPath) => {
    if (mockFileSystem.has(oldPath)) {
      mockFileSystem.set(newPath, mockFileSystem.get(oldPath));
      mockFileSystem.delete(oldPath);
    }
  }),

  // Promise-based methods
  promises: {
    readFile: vi.fn(async (path) => {
      if (mockFileSystem.has(path)) {
        return mockFileSystem.get(path);
      }
      const error = new Error(`ENOENT: no such file or directory, open '${path}'`);
      error.code = 'ENOENT';
      throw error;
    }),

    writeFile: vi.fn(async (path, data) => {
      mockFileSystem.set(path, data);
    }),

    access: vi.fn(async (path) => {
      if (!mockFileSystem.has(path)) {
        const error = new Error(`ENOENT: no such file or directory, access '${path}'`);
        error.code = 'ENOENT';
        throw error;
      }
    }),

    mkdir: vi.fn(async () => {}),

    readdir: vi.fn(async (path) => fs.readdirSync(path)),

    unlink: vi.fn(async (path) => {
      mockFileSystem.delete(path);
    }),

    stat: vi.fn(async (path) => fs.statSync(path)),

    copyFile: vi.fn(async (src, dest) => {
      fs.copyFileSync(src, dest);
    }),

    rename: vi.fn(async (oldPath, newPath) => {
      fs.renameSync(oldPath, newPath);
    }),
  },
};

// Helper to set up mock files
export function setMockFile(path, content) {
  mockFileSystem.set(path, content);
}

// Helper to clear all mock files
export function clearMockFiles() {
  mockFileSystem.clear();
}

// Helper to get all mock files
export function getMockFiles() {
  return new Map(mockFileSystem);
}

export default fs;
