/**
 * MultiTenantStore Unit Tests
 * Tests token management, partition tracking, environment detection, and security
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock Electron session API
vi.mock('electron', () => ({
  session: {
    fromPartition: vi.fn(() => ({
      cookies: {
        on: vi.fn(),
        removeListener: vi.fn(),
        set: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue([])
      }
    }))
  }
}));

// Mock settingsManager
vi.mock('../../settings-manager', () => ({
  getSettingsManager: vi.fn(() => ({
    get: vi.fn(),
    set: vi.fn()
  }))
}));

// Import after mocks are set up
const multiTenantStore = require('../../multi-tenant-store');

describe('MultiTenantStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset store state for each test
    multiTenantStore.tokens = {};
    multiTenantStore.activePartitions = {};
    multiTenantStore.listenedPartitions = new Set();
    multiTenantStore.listenerCleanup = new Map();
  });

  describe('Token Management', () => {
    it('should store token for environment', async () => {
      await multiTenantStore.setToken('edison', {
        value: 'test-token-value',
        domain: '.edison.api.onereach.ai',
        expiresAt: Math.floor(Date.now() / 1000) + 3600
      });
      
      expect(multiTenantStore.tokens.edison).toBeDefined();
      expect(multiTenantStore.tokens.edison.value).toBe('test-token-value');
      expect(multiTenantStore.tokens.edison.capturedAt).toBeDefined();
    });

    it('should return null for missing token', () => {
      expect(multiTenantStore.getToken('nonexistent')).toBeNull();
    });

    it('should return stored token', async () => {
      multiTenantStore.tokens.edison = { value: 'abc123', domain: '.edison.api.onereach.ai' };
      
      const token = multiTenantStore.getToken('edison');
      expect(token.value).toBe('abc123');
    });

    it('should report hasToken correctly', () => {
      expect(multiTenantStore.hasToken('edison')).toBe(false);
      
      multiTenantStore.tokens.edison = { value: 'test' };
      expect(multiTenantStore.hasToken('edison')).toBe(true);
    });

    it('should validate expired tokens', () => {
      // Expired token (1 hour ago)
      multiTenantStore.tokens.edison = {
        value: 'expired',
        expiresAt: Math.floor(Date.now() / 1000) - 3600
      };
      
      expect(multiTenantStore.hasValidToken('edison')).toBe(false);
    });

    it('should validate non-expired tokens', () => {
      // Valid token (1 hour from now)
      multiTenantStore.tokens.edison = {
        value: 'valid',
        expiresAt: Math.floor(Date.now() / 1000) + 3600
      };
      
      expect(multiTenantStore.hasValidToken('edison')).toBe(true);
    });

    it('should clear token', () => {
      multiTenantStore.tokens.edison = { value: 'test' };
      multiTenantStore.clearToken('edison');
      
      expect(multiTenantStore.tokens.edison).toBeUndefined();
    });

    it('should list environments with valid tokens', () => {
      multiTenantStore.tokens.edison = { value: 'a', expiresAt: Math.floor(Date.now() / 1000) + 3600 };
      multiTenantStore.tokens.staging = { value: 'b', expiresAt: Math.floor(Date.now() / 1000) - 3600 }; // expired
      multiTenantStore.tokens.production = { value: 'c', expiresAt: Math.floor(Date.now() / 1000) + 3600 };
      
      const envs = multiTenantStore.getEnvironmentsWithTokens();
      expect(envs).toContain('edison');
      expect(envs).toContain('production');
      expect(envs).not.toContain('staging');
    });
  });

  describe('Partition Management', () => {
    it('should register partition for environment', () => {
      multiTenantStore.registerPartition('edison', 'persist:tab-123');
      
      expect(multiTenantStore.activePartitions.edison).toBeDefined();
      expect(multiTenantStore.activePartitions.edison.has('persist:tab-123')).toBe(true);
    });

    it('should register multiple partitions', () => {
      multiTenantStore.registerPartition('edison', 'persist:tab-1');
      multiTenantStore.registerPartition('edison', 'persist:tab-2');
      multiTenantStore.registerPartition('edison', 'persist:gsx-edison');
      
      expect(multiTenantStore.activePartitions.edison.size).toBe(3);
    });

    it('should unregister partition', () => {
      multiTenantStore.registerPartition('edison', 'persist:tab-1');
      multiTenantStore.registerPartition('edison', 'persist:tab-2');
      multiTenantStore.unregisterPartition('edison', 'persist:tab-1');
      
      expect(multiTenantStore.activePartitions.edison.size).toBe(1);
      expect(multiTenantStore.activePartitions.edison.has('persist:tab-1')).toBe(false);
      expect(multiTenantStore.activePartitions.edison.has('persist:tab-2')).toBe(true);
    });

    it('should return active partitions as array', () => {
      multiTenantStore.registerPartition('edison', 'persist:tab-1');
      multiTenantStore.registerPartition('edison', 'persist:tab-2');
      
      const partitions = multiTenantStore.getActivePartitions('edison');
      expect(Array.isArray(partitions)).toBe(true);
      expect(partitions).toHaveLength(2);
    });

    it('should return empty array for unknown environment', () => {
      const partitions = multiTenantStore.getActivePartitions('unknown');
      expect(partitions).toEqual([]);
    });
  });

  describe('Environment Detection', () => {
    it('should detect edison environment', () => {
      expect(multiTenantStore.extractEnvironment('edison.api.onereach.ai')).toBe('edison');
      expect(multiTenantStore.extractEnvironment('.edison.api.onereach.ai')).toBe('edison');
      expect(multiTenantStore.extractEnvironment('idw.edison.onereach.ai')).toBe('edison');
    });

    it('should detect staging environment', () => {
      expect(multiTenantStore.extractEnvironment('staging.api.onereach.ai')).toBe('staging');
      expect(multiTenantStore.extractEnvironment('staging.onereach.ai')).toBe('staging');
    });

    it('should detect production environment', () => {
      expect(multiTenantStore.extractEnvironment('api.onereach.ai')).toBe('production');
      expect(multiTenantStore.extractEnvironment('my.onereach.ai')).toBe('production');
      expect(multiTenantStore.extractEnvironment('onereach.ai')).toBe('production');
    });

    it('should detect dev environment', () => {
      expect(multiTenantStore.extractEnvironment('dev.api.onereach.ai')).toBe('dev');
      expect(multiTenantStore.extractEnvironment('dev.onereach.ai')).toBe('dev');
    });

    it('should default to production for unknown domains', () => {
      expect(multiTenantStore.extractEnvironment('unknown.example.com')).toBe('production');
      expect(multiTenantStore.extractEnvironment('')).toBe('production');
      expect(multiTenantStore.extractEnvironment(null)).toBe('production');
    });

    it('should extract environment from URL', () => {
      expect(multiTenantStore.extractEnvironmentFromUrl('https://edison.onereach.ai/app')).toBe('edison');
      expect(multiTenantStore.extractEnvironmentFromUrl('https://staging.api.onereach.ai/v1/test')).toBe('staging');
      expect(multiTenantStore.extractEnvironmentFromUrl('https://my.onereach.ai/dashboard')).toBe('production');
    });

    it('should return correct API domain', () => {
      expect(multiTenantStore.getApiDomain('edison')).toBe('.edison.api.onereach.ai');
      expect(multiTenantStore.getApiDomain('staging')).toBe('.staging.api.onereach.ai');
      expect(multiTenantStore.getApiDomain('production')).toBe('.api.onereach.ai');
      expect(multiTenantStore.getApiDomain('unknown')).toBe('.api.onereach.ai');
    });
  });

  describe('Cookie Listener', () => {
    it('should prevent duplicate listeners', () => {
      const { session } = require('electron');
      
      multiTenantStore.attachCookieListener('persist:tab-1');
      multiTenantStore.attachCookieListener('persist:tab-1'); // duplicate
      
      expect(multiTenantStore.listenedPartitions.size).toBe(1);
      expect(session.fromPartition).toHaveBeenCalledTimes(1);
    });

    it('should allow listeners on different partitions', () => {
      const { session } = require('electron');
      
      multiTenantStore.attachCookieListener('persist:tab-1');
      multiTenantStore.attachCookieListener('persist:tab-2');
      
      expect(multiTenantStore.listenedPartitions.size).toBe(2);
      expect(session.fromPartition).toHaveBeenCalledTimes(2);
    });

    it('should cleanup listener on removal for tab partitions', () => {
      multiTenantStore.attachCookieListener('persist:tab-1');
      expect(multiTenantStore.listenedPartitions.has('persist:tab-1')).toBe(true);
      
      multiTenantStore.removeCookieListener('persist:tab-1');
      expect(multiTenantStore.listenedPartitions.has('persist:tab-1')).toBe(false);
      expect(multiTenantStore.listenerCleanup.has('persist:tab-1')).toBe(false);
    });

    it('should NOT cleanup GSX partition listeners', () => {
      multiTenantStore.attachCookieListener('persist:gsx-edison');
      multiTenantStore.removeCookieListener('persist:gsx-edison');
      
      // GSX listeners should NOT be removed
      expect(multiTenantStore.listenedPartitions.has('persist:gsx-edison')).toBe(true);
    });
  });

  describe('Security: Domain Validation', () => {
    it('should accept valid onereach.ai domains', () => {
      expect(multiTenantStore.isValidOneReachDomain('onereach.ai')).toBe(true);
      expect(multiTenantStore.isValidOneReachDomain('api.onereach.ai')).toBe(true);
      expect(multiTenantStore.isValidOneReachDomain('edison.onereach.ai')).toBe(true);
      expect(multiTenantStore.isValidOneReachDomain('.edison.api.onereach.ai')).toBe(true);
    });

    it('should REJECT subdomain attack domains', () => {
      // These would pass with includes() but should fail with endsWith()
      expect(multiTenantStore.isValidOneReachDomain('api.onereach.ai.attacker.com')).toBe(false);
      expect(multiTenantStore.isValidOneReachDomain('fake-onereach.ai')).toBe(false);
      expect(multiTenantStore.isValidOneReachDomain('onereach.ai.evil.com')).toBe(false);
      expect(multiTenantStore.isValidOneReachDomain('notonereach.ai')).toBe(false);
    });

    it('should handle edge cases', () => {
      expect(multiTenantStore.isValidOneReachDomain('')).toBe(false);
      expect(multiTenantStore.isValidOneReachDomain(null)).toBe(false);
      expect(multiTenantStore.isValidOneReachDomain(undefined)).toBe(false);
    });
  });

  describe('Security: URL Validation', () => {
    it('should identify valid OneReach URLs', () => {
      expect(multiTenantStore.isOneReachUrl('https://edison.onereach.ai')).toBe(true);
      expect(multiTenantStore.isOneReachUrl('https://api.onereach.ai')).toBe(true);
      expect(multiTenantStore.isOneReachUrl('https://my.onereach.ai/dashboard')).toBe(true);
    });

    it('should reject non-OneReach URLs', () => {
      expect(multiTenantStore.isOneReachUrl('https://google.com')).toBe(false);
      expect(multiTenantStore.isOneReachUrl('https://evil.com/onereach.ai')).toBe(false);
      expect(multiTenantStore.isOneReachUrl('invalid-url')).toBe(false);
    });

    it('should reject subdomain attack URLs', () => {
      expect(multiTenantStore.isOneReachUrl('https://onereach.ai.attacker.com')).toBe(false);
      expect(multiTenantStore.isOneReachUrl('https://api.onereach.ai.evil.com')).toBe(false);
    });
  });

  describe('Security: Partition Validation Patterns', () => {
    it('should accept valid tab partition format', () => {
      const validTabPattern = /^persist:tab-\d+-[a-z0-9]+$/;
      expect(validTabPattern.test('persist:tab-1234567890-abc123def')).toBe(true);
      expect(validTabPattern.test('persist:tab-9999-xyz')).toBe(true);
    });

    it('should accept valid GSX partition format', () => {
      const validGsxPattern = /^persist:gsx-(edison|staging|production|dev)$/;
      expect(validGsxPattern.test('persist:gsx-edison')).toBe(true);
      expect(validGsxPattern.test('persist:gsx-staging')).toBe(true);
      expect(validGsxPattern.test('persist:gsx-production')).toBe(true);
      expect(validGsxPattern.test('persist:gsx-dev')).toBe(true);
    });

    it('should REJECT invalid partition formats', () => {
      const tabPattern = /^persist:tab-\d+-[a-z0-9]+$/;
      const gsxPattern = /^persist:gsx-(edison|staging|production|dev)$/;
      
      const invalidPartitions = [
        'persist:malicious',
        'persist:tab-',
        'persist:gsx-unknown',
        'arbitrary-partition',
        '../../../etc/passwd',
        'persist:tab-abc-123'  // non-numeric timestamp
      ];
      
      invalidPartitions.forEach(p => {
        expect(tabPattern.test(p) || gsxPattern.test(p)).toBe(false);
      });
    });
  });
});
