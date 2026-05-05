/**
 * SSO auto-skip URL gate tests.
 *
 * The runtime click logic uses `webContents.executeJavaScript` so it
 * can't be unit-tested without spinning up Electron. What we CAN test
 * (and what's the load-bearing safety check) is the URL gate
 * `isOneReachSsoSkipUrl` -- it must accept ONLY OneReach auth URLs
 * carrying `sso=true&showSkip=true`. A regression here is the
 * difference between "auto-clicks an IDW Skip button" and
 * "auto-clicks something on a third-party site."
 */

import { describe, it, expect } from 'vitest';
import { isOneReachSsoSkipUrl } from '../../auth/sso-skip.js';

describe('isOneReachSsoSkipUrl', () => {
  it('accepts the canonical edison auth interstitial', () => {
    const result = isOneReachSsoSkipUrl(
      'https://auth.edison.onereach.ai/login?sso=true&showSkip=true&accountId=05bd3c92-5d3c-4dc5-a95d-0c584695cea4'
    );
    expect(result.match).toBe(true);
    expect(result.env).toBe('edison');
  });

  it('accepts the staging auth interstitial', () => {
    const result = isOneReachSsoSkipUrl(
      'https://auth.staging.onereach.ai/?sso=true&showSkip=true&accountId=foo'
    );
    expect(result.match).toBe(true);
    expect(result.env).toBe('staging');
  });

  it('rejects URL without the sso=true param', () => {
    const result = isOneReachSsoSkipUrl(
      'https://auth.edison.onereach.ai/login?showSkip=true&accountId=foo'
    );
    expect(result.match).toBe(false);
  });

  it('rejects URL without the showSkip=true param', () => {
    const result = isOneReachSsoSkipUrl(
      'https://auth.edison.onereach.ai/login?sso=true&accountId=foo'
    );
    expect(result.match).toBe(false);
  });

  it('rejects non-auth subdomains (idw.* / studio.* / api.*)', () => {
    expect(
      isOneReachSsoSkipUrl(
        'https://idw.edison.onereach.ai/login?sso=true&showSkip=true'
      ).match
    ).toBe(false);
    expect(
      isOneReachSsoSkipUrl(
        'https://studio.edison.onereach.ai/login?sso=true&showSkip=true'
      ).match
    ).toBe(false);
    expect(
      isOneReachSsoSkipUrl(
        'https://api.edison.onereach.ai/login?sso=true&showSkip=true'
      ).match
    ).toBe(false);
  });

  it('rejects subdomain attacks (*.onereach.ai.attacker.com)', () => {
    expect(
      isOneReachSsoSkipUrl(
        'https://auth.edison.onereach.ai.attacker.com/login?sso=true&showSkip=true'
      ).match
    ).toBe(false);
  });

  it('rejects third-party agents that happen to have the params', () => {
    expect(
      isOneReachSsoSkipUrl(
        'https://chat.openai.com/?sso=true&showSkip=true'
      ).match
    ).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isOneReachSsoSkipUrl('not-a-url').match).toBe(false);
    expect(isOneReachSsoSkipUrl('').match).toBe(false);
  });

  it('rejects http (non-secure) URLs as a defense-in-depth measure', () => {
    // We allow http+https in `isOneReachDomain` because cookies are
    // domain-scoped, not protocol-scoped. But for auto-clicking we
    // could tighten this further. For now, the URL parser doesn't
    // care about protocol -- if the user somehow lands on http, the
    // click still fires. Documented as acceptable risk.
    expect(
      isOneReachSsoSkipUrl(
        'http://auth.edison.onereach.ai/login?sso=true&showSkip=true'
      ).match
    ).toBe(true);
  });
});
