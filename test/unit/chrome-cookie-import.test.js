import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFs = {
  accessSync: vi.fn(),
  copyFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  constants: { R_OK: 4 },
};

const mockExecSync = vi.fn();

const mockCookieStore = {
  set: vi.fn().mockResolvedValue(undefined),
  flushStore: vi.fn().mockResolvedValue(undefined),
};

const mockElectron = {
  session: {
    fromPartition: vi.fn().mockReturnValue({ cookies: mockCookieStore }),
  },
};

describe('chrome-cookie-import', () => {
  let chromeImport;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../../lib/chrome-cookie-import.js');
    chromeImport = mod.default || mod;
    chromeImport._injectDeps({ fs: mockFs, execSync: mockExecSync, electron: mockElectron, resetCaches: true });
  });

  describe('getChromeProfilePath', () => {
    it('should return a path for the current platform', () => {
      const result = chromeImport.getChromeProfilePath();
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
      expect(result).toContain('Chrome');
    });
  });

  describe('isChromeAvailable', () => {
    it('should return true when cookie file is accessible', () => {
      mockFs.accessSync.mockReturnValue(undefined);
      expect(chromeImport.isChromeAvailable()).toBe(true);
    });

    it('should return false when cookie file is not accessible', () => {
      mockFs.accessSync.mockImplementation(() => { throw new Error('ENOENT'); });
      expect(chromeImport.isChromeAvailable()).toBe(false);
    });
  });

  describe('_decryptValue', () => {
    it('should return empty string for null input', () => {
      expect(chromeImport._decryptValue(null, Buffer.alloc(16))).toBe('');
    });

    it('should return empty string for too-short input', () => {
      expect(chromeImport._decryptValue(Buffer.from('ab'), Buffer.alloc(16))).toBe('');
    });

    it('should return empty string when no key provided', () => {
      expect(chromeImport._decryptValue(Buffer.from('v10encrypted'), null)).toBe('');
    });

    it('should return raw utf8 for non-v10 prefixed data', () => {
      const buf = Buffer.from('plaintext_cookie_value');
      expect(chromeImport._decryptValue(buf, Buffer.alloc(16))).toBe('plaintext_cookie_value');
    });
  });

  describe('_chromeSameSiteToElectron', () => {
    it('should map Chrome sameSite values to Electron format', () => {
      expect(chromeImport._chromeSameSiteToElectron(0)).toBe('no_restriction');
      expect(chromeImport._chromeSameSiteToElectron(1)).toBe('lax');
      expect(chromeImport._chromeSameSiteToElectron(2)).toBe('strict');
      expect(chromeImport._chromeSameSiteToElectron(-1)).toBeUndefined();
    });
  });

  describe('_chromeTimestampToUnix', () => {
    it('should return undefined for 0 timestamp', () => {
      expect(chromeImport._chromeTimestampToUnix(0)).toBeUndefined();
    });

    it('should convert Chrome timestamp to Unix epoch', () => {
      const chromeTs = (1704067200 + 11644473600) * 1000000;
      expect(chromeImport._chromeTimestampToUnix(chromeTs)).toBe(1704067200);
    });
  });

  describe('importChromeCookies', () => {
    it('should return early when Chrome is not available', async () => {
      mockFs.accessSync.mockImplementation(() => { throw new Error('ENOENT'); });

      const result = await chromeImport.importChromeCookies('example.com', 'persist:test');
      expect(result.imported).toBe(0);
      expect(result.reason).toBe('chrome-not-available');
    });

    it('should return 0 when no cookies found in db', async () => {
      mockFs.accessSync.mockReturnValue(undefined);
      mockExecSync
        .mockReturnValueOnce('mock-key') // _getChromeDecryptionKey -> security command
        .mockReturnValueOnce('');         // _queryCookieDb -> sqlite3 query

      const result = await chromeImport.importChromeCookies('example.com', 'persist:test');
      expect(result.imported).toBe(0);
      expect(result.reason).toBe('no-cookies-found');
    });

    it('should import cookies when found and decryptable', async () => {
      mockFs.accessSync.mockReturnValue(undefined);
      mockFs.copyFileSync.mockReturnValue(undefined);
      mockFs.unlinkSync.mockReturnValue(undefined);

      mockExecSync
        .mockReturnValueOnce('mock-key') // _getChromeDecryptionKey
        .mockReturnValueOnce(            // _queryCookieDb sqlite3 output
          '.example.com|||session|||/|||1|||0|||0|||706c61696e|||1\n'
        );

      const result = await chromeImport.importChromeCookies('example.com', 'persist:test');
      expect(result.total).toBe(1);
    });
  });

  describe('_queryCookieDb', () => {
    it('should return empty array when sqlite3 fails', () => {
      mockExecSync.mockImplementation(() => { throw new Error('sqlite3 not found'); });
      const result = chromeImport._queryCookieDb('/fake/path', 'example.com');
      expect(result).toEqual([]);
    });

    it('should parse sqlite3 output correctly', () => {
      mockFs.copyFileSync.mockReturnValue(undefined);
      mockExecSync.mockReturnValue(
        '.example.com|||session_id|||/|||1|||0|||0|||AABB|||1\n' +
        '.example.com|||token|||/api|||1|||1|||13340000000000000|||CCDD|||-1\n'
      );
      mockFs.unlinkSync.mockReturnValue(undefined);

      const result = chromeImport._queryCookieDb('/fake/Cookies', 'example.com');
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('session_id');
      expect(result[0].is_secure).toBe(true);
      expect(result[0].is_httponly).toBe(false);
      expect(result[1].name).toBe('token');
      expect(result[1].is_httponly).toBe(true);
    });
  });

  describe('Key caching', () => {
    it('should only call security command once across multiple imports', async () => {
      mockFs.accessSync.mockReturnValue(undefined);
      mockFs.copyFileSync.mockReturnValue(undefined);
      mockFs.unlinkSync.mockReturnValue(undefined);

      mockExecSync
        .mockReturnValueOnce('mock-key')  // first: keychain
        .mockReturnValueOnce('')          // first: sqlite (empty)
        .mockReturnValueOnce('');          // second: sqlite (empty) - no keychain call

      await chromeImport.importChromeCookies('a.com', 'persist:t1');
      await chromeImport.importChromeCookies('b.com', 'persist:t2');

      // execSync called 3 times: 1 keychain + 2 sqlite queries (NOT 2 keychain + 2 sqlite)
      expect(mockExecSync).toHaveBeenCalledTimes(3);
    });

    it('should not retry keychain after failure', async () => {
      mockFs.accessSync.mockReturnValue(undefined);
      mockExecSync.mockImplementation(() => { throw new Error('denied'); });

      await chromeImport.importChromeCookies('a.com', 'persist:t1');

      expect(chromeImport.isChromeAvailable()).toBe(false);

      const result = await chromeImport.importChromeCookies('b.com', 'persist:t2');
      expect(result.reason).toBe('chrome-not-available');
      expect(mockExecSync).toHaveBeenCalledTimes(1);
    });
  });

  describe('Domain failure caching', () => {
    it('should remember domains with no cookies', async () => {
      mockFs.accessSync.mockReturnValue(undefined);
      mockFs.copyFileSync.mockReturnValue(undefined);
      mockFs.unlinkSync.mockReturnValue(undefined);
      mockExecSync
        .mockReturnValueOnce('mock-key')
        .mockReturnValueOnce('');

      await chromeImport.importChromeCookies('empty.com', 'persist:t');
      expect(chromeImport.isDomainFailed('empty.com')).toBe(true);

      const result = await chromeImport.importChromeCookies('empty.com', 'persist:t');
      expect(result.reason).toBe('domain-previously-failed');
    });

    it('should allow new domains after one fails', async () => {
      mockFs.accessSync.mockReturnValue(undefined);
      mockFs.copyFileSync.mockReturnValue(undefined);
      mockFs.unlinkSync.mockReturnValue(undefined);
      mockExecSync
        .mockReturnValueOnce('mock-key')
        .mockReturnValueOnce('')
        .mockReturnValueOnce('.new.com|||s|||/|||0|||0|||0|||706c61696e|||0\n');

      await chromeImport.importChromeCookies('empty.com', 'persist:t');
      expect(chromeImport.isDomainFailed('empty.com')).toBe(true);
      expect(chromeImport.isDomainFailed('new.com')).toBe(false);
    });
  });
});
