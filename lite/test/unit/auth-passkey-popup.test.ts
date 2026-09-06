/**
 * Passkeys hidden from Google's popup (ADR-096): the script registers
 * before any document, only google.com hosts are touched, failures are
 * reported and never thrown.
 */
import { describe, it, expect, vi } from 'vitest';
import { HIDE_PASSKEYS_SCRIPT, hidePasskeysFromGooglePopup } from '../../auth/passkey-popup.js';

const fake = (opts: { attachThrows?: boolean; attached?: boolean } = {}) => {
  const calls: string[] = [];
  const listeners: Array<() => void> = [];
  let attached = opts.attached === true;
  const contents = {
    isDestroyed: () => false,
    once: (_e: 'destroyed', l: () => void) => { listeners.push(l); },
    debugger: {
      isAttached: () => attached,
      attach: (v?: string) => { if (opts.attachThrows) throw new Error('Another debugger is already attached'); attached = true; calls.push(`attach ${v}`); },
      detach: () => { attached = false; calls.push('detach'); },
      sendCommand: async (m: string, p?: Record<string, unknown>) => { calls.push(`${m}:${String((p?.['source'] as string | undefined)?.length ?? 0)}`); return {}; },
    },
  };
  return { contents, calls, listeners };
};

describe('auth passkey-popup', () => {
  it('attaches once, registers the script for new documents, detaches on destroy, and reports', async () => {
    const { contents, calls, listeners } = fake();
    const log = vi.fn();
    expect(await hidePasskeysFromGooglePopup(contents, log)).toBe(true);
    expect(calls[0]).toBe('attach 1.3');
    expect(calls[1]).toBe('Page.enable:0');
    expect(calls[2]).toBe(`Page.addScriptToEvaluateOnNewDocument:${HIDE_PASSKEYS_SCRIPT.length}`);
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('passkeys hidden'), {});
    listeners[0]!();
    expect(calls[3]).toBe('detach');
    const already = fake({ attached: true });
    await hidePasskeysFromGooglePopup(already.contents);
    expect(already.calls[0]).toBe('Page.enable:0');
    expect(already.calls[1]).toMatch(/^Page\.addScriptToEvaluateOnNewDocument/);
  });

  it('a popup that cannot be attached keeps working and the failure is reported, never thrown', async () => {
    const { contents } = fake({ attachThrows: true });
    const log = vi.fn();
    expect(await hidePasskeysFromGooglePopup(contents, log)).toBe(false);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('could not hide passkeys'), { error: 'Another debugger is already attached' });
  });

  it('the script touches accounts.google.com documents only and removes exactly WebAuthn', () => {
    expect(HIDE_PASSKEYS_SCRIPT).toContain("location.hostname !== 'accounts.google.com'");
    expect(HIDE_PASSKEYS_SCRIPT).toContain("'PublicKeyCredential'");
    expect(HIDE_PASSKEYS_SCRIPT).toContain('NotSupportedError');
    expect(HIDE_PASSKEYS_SCRIPT).not.toMatch(/lite|ipcRenderer|require\(/);
  });
});
