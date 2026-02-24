import { describe, it, expect, beforeEach } from 'vitest';

describe('BrowseSafety', () => {
  let safety;

  beforeEach(async () => {
    safety = await import('../../lib/browse-safety.js');
    safety.resetCustomConfig();
  });

  describe('isDomainBlocked()', () => {
    it('should block localhost', () => {
      expect(safety.isDomainBlocked('http://localhost:3000').blocked).toBe(true);
      expect(safety.isDomainBlocked('http://127.0.0.1').blocked).toBe(true);
      expect(safety.isDomainBlocked('http://0.0.0.0:8080').blocked).toBe(true);
    });

    it('should block private IP ranges', () => {
      expect(safety.isDomainBlocked('http://192.168.1.1').blocked).toBe(true);
      expect(safety.isDomainBlocked('http://10.0.0.1').blocked).toBe(true);
      expect(safety.isDomainBlocked('http://172.16.0.1').blocked).toBe(true);
    });

    it('should block cloud consoles', () => {
      expect(safety.isDomainBlocked('https://console.aws.amazon.com/ec2').blocked).toBe(true);
      expect(safety.isDomainBlocked('https://console.cloud.google.com').blocked).toBe(true);
      expect(safety.isDomainBlocked('https://portal.azure.com').blocked).toBe(true);
    });

    it('should block dangerous protocols', () => {
      expect(safety.isDomainBlocked('file:///etc/passwd').blocked).toBe(true);
      expect(safety.isDomainBlocked('javascript:alert(1)').blocked).toBe(true);
      expect(safety.isDomainBlocked('data:text/html,<script>').blocked).toBe(true);
    });

    it('should allow normal websites', () => {
      expect(safety.isDomainBlocked('https://example.com').blocked).toBe(false);
      expect(safety.isDomainBlocked('https://github.com/repo').blocked).toBe(false);
      expect(safety.isDomainBlocked('https://news.ycombinator.com').blocked).toBe(false);
    });

    it('should block invalid URLs', () => {
      expect(safety.isDomainBlocked('not-a-url').blocked).toBe(true);
    });

    it('should block custom domains', () => {
      safety.addBlockedDomain('evil.com');
      expect(safety.isDomainBlocked('https://evil.com').blocked).toBe(true);
      expect(safety.isDomainBlocked('https://sub.evil.com').blocked).toBe(true);
      expect(safety.isDomainBlocked('https://notevil.com').blocked).toBe(false);
    });

    it('should unblock custom domains', () => {
      safety.addBlockedDomain('temp.com');
      expect(safety.isDomainBlocked('https://temp.com').blocked).toBe(true);

      safety.removeBlockedDomain('temp.com');
      expect(safety.isDomainBlocked('https://temp.com').blocked).toBe(false);
    });
  });

  describe('isSensitiveField()', () => {
    it('should detect password fields', () => {
      expect(safety.isSensitiveField({ type: 'password' }).sensitive).toBe(true);
      expect(safety.isSensitiveField({ name: 'user_password' }).sensitive).toBe(true);
      expect(safety.isSensitiveField({ label: 'Enter your password' }).sensitive).toBe(true);
    });

    it('should detect credit card fields', () => {
      expect(safety.isSensitiveField({ autocomplete: 'cc-number' }).sensitive).toBe(true);
      expect(safety.isSensitiveField({ name: 'credit_card_number' }).sensitive).toBe(true);
      expect(safety.isSensitiveField({ name: 'card-number' }).sensitive).toBe(true);
    });

    it('should detect CVV/CSC fields', () => {
      expect(safety.isSensitiveField({ name: 'cvv' }).sensitive).toBe(true);
      expect(safety.isSensitiveField({ name: 'cvc' }).sensitive).toBe(true);
      expect(safety.isSensitiveField({ label: 'Security Code' }).sensitive).toBe(true);
    });

    it('should detect SSN fields', () => {
      expect(safety.isSensitiveField({ name: 'ssn' }).sensitive).toBe(true);
      expect(safety.isSensitiveField({ name: 'social_security_number' }).sensitive).toBe(true);
    });

    it('should detect bank account fields', () => {
      expect(safety.isSensitiveField({ name: 'bank_account' }).sensitive).toBe(true);
      expect(safety.isSensitiveField({ name: 'routing_number' }).sensitive).toBe(true);
    });

    it('should not flag normal fields', () => {
      expect(safety.isSensitiveField({ name: 'email', type: 'email' }).sensitive).toBe(false);
      expect(safety.isSensitiveField({ name: 'first_name', type: 'text' }).sensitive).toBe(false);
      expect(safety.isSensitiveField({ name: 'search', type: 'search' }).sensitive).toBe(false);
      expect(safety.isSensitiveField({ name: 'message', type: 'textarea' }).sensitive).toBe(false);
    });
  });

  describe('checkActionSafety()', () => {
    const baseSessionState = {
      actionCount: 0,
      navigationCount: 0,
      startTime: Date.now(),
    };

    it('should allow safe actions', () => {
      const result = safety.checkActionSafety(
        { action: 'click', ref: 1 },
        baseSessionState,
      );
      expect(result.safe).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should block when max actions exceeded', () => {
      const result = safety.checkActionSafety(
        { action: 'click', ref: 1 },
        { ...baseSessionState, actionCount: 999 },
      );
      expect(result.safe).toBe(false);
      expect(result.issues[0].severity).toBe('block');
    });

    it('should block navigation to blocked domains', () => {
      const result = safety.checkActionSafety(
        { action: 'navigate', url: 'http://localhost:3000' },
        baseSessionState,
      );
      expect(result.safe).toBe(false);
      expect(result.issues[0].reason).toContain('blocklisted');
    });

    it('should warn on sensitive field fill', () => {
      const result = safety.checkActionSafety(
        { action: 'fill', ref: 5, fieldInfo: { type: 'password', name: 'password' } },
        baseSessionState,
      );
      expect(result.safe).toBe(true); // warns but doesn't block
      expect(result.requiresConfirmation).toBe(true);
    });

    it('should block when session duration exceeded', () => {
      const result = safety.checkActionSafety(
        { action: 'click', ref: 1 },
        { ...baseSessionState, startTime: Date.now() - 600000 },
      );
      expect(result.safe).toBe(false);
    });
  });

  describe('validateSessionCreation()', () => {
    it('should allow session creation under limit', () => {
      expect(safety.validateSessionCreation(3).allowed).toBe(true);
    });

    it('should block when max sessions reached', () => {
      expect(safety.validateSessionCreation(10).allowed).toBe(false);
    });
  });

  describe('Custom Configuration', () => {
    it('should get and set custom limits', () => {
      safety.setLimits({ maxActionsPerSession: 100 });
      const limits = safety.getLimits();
      expect(limits.maxActionsPerSession).toBe(100);
      expect(limits.maxSessionsTotal).toBe(10); // unchanged default
    });

    it('should list all blocked domains', () => {
      safety.addBlockedDomain('test.com');
      const domains = safety.getBlockedDomains();
      expect(domains).toContain('localhost');
      expect(domains).toContain('test.com');
    });

    it('should reset all custom config', () => {
      safety.addBlockedDomain('custom.com');
      safety.setLimits({ maxActionsPerSession: 999 });

      safety.resetCustomConfig();

      expect(safety.getBlockedDomains()).not.toContain('custom.com');
      expect(safety.getLimits().maxActionsPerSession).toBe(50);
    });
  });
});
