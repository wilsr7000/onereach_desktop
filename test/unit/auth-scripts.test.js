import { describe, it, expect } from 'vitest';
import vm from 'vm';

const authScripts = require('../../lib/auth-scripts');

describe('lib/auth-scripts', () => {
  describe('SELECTORS', () => {
    it('exports all required selector keys', () => {
      const keys = Object.keys(authScripts.SELECTORS);
      expect(keys).toContain('email');
      expect(keys).toContain('password');
      expect(keys).toContain('totp');
      expect(keys).toContain('submit');
      expect(keys).toContain('error');
      expect(keys).toContain('accountSelect');
      expect(keys).toContain('accountClickable');
      expect(keys).toContain('authContent');
    });

    it('totp selector includes verificationCode and twoFactorCode', () => {
      expect(authScripts.SELECTORS.totp).toContain('verificationCode');
      expect(authScripts.SELECTORS.totp).toContain('twoFactorCode');
    });

    it('email selector covers autocomplete="email" and autocomplete="username"', () => {
      expect(authScripts.SELECTORS.email).toContain('autocomplete="email"');
      expect(authScripts.SELECTORS.email).toContain('autocomplete="username"');
    });
  });

  describe('script builders produce valid JavaScript', () => {
    const builders = [
      { name: 'buildDetectFormLocationScript', args: [] },
      { name: 'buildDetectPageTypeScript', args: [] },
      { name: 'buildDetect2FAScript', args: [] },
      { name: 'buildFillLoginScript', args: ['user@example.com', 'p@ss"w0rd'] },
      { name: 'buildFillLoginScript (no submit)', args: ['u@e.com', 'pw', { autoSubmit: false }] },
      { name: 'buildIframeLoginScript', args: ['user@example.com', 'p@ss"w0rd'] },
      { name: 'buildFillTOTPScript', args: ['123456'] },
      { name: 'buildFillTOTPScript (no submit)', args: ['654321', { autoSubmit: false }] },
      { name: 'buildSubmitButtonScript', args: [] },
      { name: 'buildSubmitButtonScript (custom)', args: [['verify', 'confirm']] },
      { name: 'buildSelectAccountScript', args: ['acct-abc-123'] },
      { name: 'buildAuthStateCheckScript', args: [] },
      { name: 'buildCheckAuthStatusScript', args: [] },
      { name: 'buildWaitForAuthFormScript', args: [10000] },
    ];

    for (const { name, args } of builders) {
      it(`${name} returns parseable JS`, () => {
        const fnName = name.replace(/ \(.*/, '');
        const script = authScripts[fnName](...args);

        expect(typeof script).toBe('string');
        expect(script.length).toBeGreaterThan(50);

        // vm.compileFunction validates syntax without executing
        expect(() => vm.compileFunction(script)).not.toThrow();
      });
    }
  });

  describe('credential escaping', () => {
    it('handles special characters in email/password', () => {
      const script = authScripts.buildFillLoginScript(
        'user"with\'quotes@test.com',
        'pass\\with\nnewline'
      );
      expect(() => vm.compileFunction(script)).not.toThrow();
    });

    it('handles special characters in TOTP code', () => {
      const script = authScripts.buildFillTOTPScript('000000');
      expect(() => vm.compileFunction(script)).not.toThrow();
    });

    it('handles special characters in account ID', () => {
      const script = authScripts.buildSelectAccountScript('id-with"quotes&<>');
      expect(() => vm.compileFunction(script)).not.toThrow();
    });
  });

  describe('options work correctly', () => {
    it('buildFillLoginScript with autoSubmit:false omits clickSubmit', () => {
      const withSubmit = authScripts.buildFillLoginScript('a@b.c', 'pw');
      const noSubmit = authScripts.buildFillLoginScript('a@b.c', 'pw', { autoSubmit: false });

      expect(withSubmit).toContain('clickSubmit');
      expect(noSubmit).not.toContain('clickSubmit');
    });

    it('buildFillTOTPScript with autoSubmit:false omits clickSubmit', () => {
      const withSubmit = authScripts.buildFillTOTPScript('123456');
      const noSubmit = authScripts.buildFillTOTPScript('123456', { autoSubmit: false });

      expect(withSubmit).toContain('clickSubmit');
      expect(noSubmit).not.toContain('clickSubmit');
    });
  });
});
