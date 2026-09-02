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

describe('buildFallbackSelectAccountScript — Edison v3 picker: plain <div> rows (2026-09-02)', () => {
  // The live failure ("login issues AGAIN", Marvin 2, 02:53:02Z): the
  // wait script SAW the email in body text (type:'email'), but the
  // fallback answered email_not_found — Edison's v3 list-users page
  // renders each account as a plain <div> row: no <a>/<li>/<button>,
  // no "account"/"user" class, the email in a nested <span>. Nothing
  // in the CLICKABLE selector contained it, so the user was told to
  // pick manually. These DOMs mirror that shape.
  function v3PickerDom(rows: string[], rowStyle = 'cursor:pointer'): void {
    document.body.innerHTML = `<div class="or-list-v3 layout-column">${rows
      .map(
        (r) =>
          `<div class="or-list-item-v3 layout-row" style="${rowStyle}"><div class="avatar"></div><div class="meta"><span class="name">${r.split(' (')[0]}</span><span class="email">${r.replace(/^.*\(|\)$/g, '')}</span></div></div>`
      )
      .join('')}</div>`;
  }

  it('clicks the pointer-cursor <div> row that holds the email (ancestor walk)', () => {
    v3PickerDom(['Ada (ada@x.com)', `Robb Wilson (${EMAIL})`, 'Bo (bo@y.com)']);
    const clicked: string[] = [];
    document.querySelectorAll('.or-list-item-v3').forEach((row) => {
      row.addEventListener('click', () => clicked.push(row.textContent ?? ''));
    });
    const result = eval(buildFallbackSelectAccountScript(EMAIL)) as {
      success?: boolean;
      method?: string;
      depth?: number;
    };
    expect(result.success).toBe(true);
    expect(result.method).toBe('email-ancestor-walk');
    expect(clicked).toHaveLength(1);
    expect(clicked[0]).toContain(EMAIL);
    expect(clicked[0]).not.toContain('ada@x.com');
  });

  it('with no clickable signal at all, clicks the email text so the click bubbles to the row', () => {
    v3PickerDom(['Ada (ada@x.com)', `Robb Wilson (${EMAIL})`], '');
    const clicked: string[] = [];
    document.querySelectorAll('.or-list-item-v3').forEach((row) => {
      row.addEventListener('click', () => clicked.push(row.textContent ?? ''));
    });
    const result = eval(buildFallbackSelectAccountScript(EMAIL)) as {
      success?: boolean;
      method?: string;
    };
    expect(result.success).toBe(true);
    expect(result.method).toBe('email-text-bubble');
    expect(clicked).toHaveLength(1);
    expect(clicked[0]).toContain(EMAIL);
  });

  it('never picks a row for someone else — no email match means no click', () => {
    v3PickerDom(['Ada (ada@x.com)', 'Bo (bo@y.com)']);
    let clicks = 0;
    document.querySelectorAll('.or-list-item-v3').forEach((row) => {
      row.addEventListener('click', () => clicks++);
    });
    const result = eval(buildFallbackSelectAccountScript(EMAIL)) as {
      success?: boolean;
      reason?: string;
    };
    expect(result.success).not.toBe(true);
    expect(result.reason).toBe('email_not_found');
    expect(clicks).toBe(0);
  });

  it('the legacy <li> picker still takes the email-text path (no behavior change)', () => {
    pickerDom(['Ada (ada@x.com)', `Robb Wilson (${EMAIL})`]);
    const result = eval(buildFallbackSelectAccountScript(EMAIL)) as { method?: string };
    expect(result.method).toBe('email-text');
  });
});
