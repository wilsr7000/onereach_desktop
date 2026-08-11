/**
 * Account-picker fallback scripts (2026-08-11). The id-based matcher
 * can NEVER succeed on OneReach's real multi-user/list-users page — it
 * renders emails, not account ids (live observer_timeout, 2026-08-10
 * 22:59:21). These tests EXECUTE the injected scripts against a jsdom
 * page shaped like that picker.
 */

// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  buildWaitForAccountPickerScript,
  buildFallbackSelectAccountScript,
} from '../../auth/totp-autofill.js';

const EMAIL = 'robb@onereach.com';

function pickerDom(rows: string[]): void {
  document.body.innerHTML = `<div class="user-list">${rows
    .map((r) => `<li class="user-row"><span>${r}</span></li>`)
    .join('')}</div>`;
}

/* eslint-disable no-eval */
describe('buildWaitForAccountPickerScript — email fallback matching', () => {
  it('resolves found:true type:email when the page shows the email but not the id', async () => {
    pickerDom(['Ada (ada@x.com)', `Robb Wilson (${EMAIL})`]);
    const script = buildWaitForAccountPickerScript('15bca0b6-not-in-dom', 500, EMAIL);
    const result = (await eval(script)) as { found?: boolean; type?: string };
    expect(result.found).toBe(true);
    expect(result.type).toBe('email');
  });

  it('still resolves observer_timeout when neither id nor email render', async () => {
    pickerDom(['Ada (ada@x.com)']);
    const script = buildWaitForAccountPickerScript('id-not-in-dom', 40, 'nobody@nowhere.dev');
    const result = (await eval(script)) as { found?: boolean; reason?: string };
    expect(result.found).not.toBe(true);
    expect(result.reason).toBe('observer_timeout');
  });

  it('id match still wins when the id IS in the DOM (no behavior change)', async () => {
    document.body.innerHTML = `<a href="/pick?accountId=abc-123">Robb</a>`;
    const result = (await eval(buildWaitForAccountPickerScript('abc-123', 500, EMAIL))) as {
      found?: boolean;
      type?: string;
    };
    expect(result.found).toBe(true);
    expect(result.type).toBe('link');
  });
});

describe('buildFallbackSelectAccountScript — email + single-account clicks', () => {
  it('clicks the row whose text contains the email', async () => {
    pickerDom(['Ada (ada@x.com)', `Robb Wilson (${EMAIL})`]);
    const clicked: string[] = [];
    document.querySelectorAll('li').forEach((li) => {
      li.addEventListener('click', () => clicked.push(li.textContent ?? ''));
    });
    const result = eval(buildFallbackSelectAccountScript(EMAIL)) as {
      success?: boolean;
      method?: string;
    };
    expect(result.success).toBe(true);
    expect(result.method).toBe('email-text');
    expect(clicked).toHaveLength(1);
    expect(clicked[0]).toContain(EMAIL);
  });

  it('clicks the only account row when there is exactly one (no email needed)', async () => {
    pickerDom([`Robb Wilson (${EMAIL})`]);
    let clicks = 0;
    document.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => clicks++));
    const result = eval(buildFallbackSelectAccountScript(null)) as {
      success?: boolean;
      method?: string;
    };
    expect(result.success).toBe(true);
    expect(result.method).toBe('single-account');
    expect(clicks).toBe(1);
  });

  it('refuses to guess among multiple accounts without an email match', async () => {
    pickerDom(['Ada (ada@x.com)', 'Bo (bo@y.com)']);
    let clicks = 0;
    document.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => clicks++));
    const result = eval(buildFallbackSelectAccountScript('nobody@nowhere.dev')) as {
      success?: boolean;
      reason?: string;
    };
    expect(result.success).not.toBe(true);
    expect(clicks).toBe(0);
    expect(result.reason).toBe('email_not_found');
  });

  it('is case-insensitive on the email', async () => {
    pickerDom([`ROBB WILSON (ROBB@ONEREACH.COM)`, 'Ada (ada@x.com)']);
    let clicks = 0;
    document.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => clicks++));
    const result = eval(buildFallbackSelectAccountScript(EMAIL)) as { success?: boolean };
    expect(result.success).toBe(true);
    expect(clicks).toBe(1);
  });
});
