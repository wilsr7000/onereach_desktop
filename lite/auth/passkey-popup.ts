/**
 * Hide passkeys from Google's sign-in popup (ADR-096, 2026-09-06).
 *
 * Google's sign-in offers "use your passkey" whenever the page sees
 * WebAuthn support, then runs a ceremony that cannot finish here: the
 * user's Google passkey lives in iCloud Keychain / a Chrome profile, and
 * Electron reaches neither (robb, live: "Google says I can access using my
 * passkey, but it does not work"). The app's own Touch ID authenticator
 * (ADR-066) only knows passkeys enrolled inside the app.
 *
 * So a popup hides WebAuthn from google.com documents before any page
 * script runs, and Google goes straight to its other methods. The script
 * runs in the page's own world through the DevTools channel
 * (`Page.addScriptToEvaluateOnNewDocument`); a preload cannot do this
 * under contextIsolation, and `executeJavaScript` is too late. Nothing
 * is exposed to the page; only two globals are removed, only on google.com.
 */
import type { WebContents } from 'electron';

/** The script every new document in the popup runs first. */
export const HIDE_PASSKEYS_SCRIPT = `(() => {
  if (!/(^|\\.)google\\.com$/.test(location.hostname)) return;
  try { Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true, writable: true }); } catch {}
  try {
    const c = navigator.credentials;
    if (c) {
      const nope = () => Promise.reject(new DOMException('Passkeys are not available in this window.', 'NotSupportedError'));
      Object.defineProperty(c, 'get', { value: nope, configurable: true });
      Object.defineProperty(c, 'create', { value: nope, configurable: true });
    }
  } catch {}
})();`;

/** The slice of `webContents` this needs (a test seam). */
export interface PopupContentsLike {
  isDestroyed(): boolean;
  once(event: 'destroyed', listener: () => void): unknown;
  debugger: {
    isAttached(): boolean;
    attach(version?: string): void;
    detach(): void;
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
  };
}

/**
 * Attach the DevTools channel to a popup and register the script. Best
 * effort: a popup that cannot be attached (another client holds it)
 * keeps working, only without the hiding; the outcome is reported to
 * the logger so support can see which.
 */
export async function hidePasskeysFromGooglePopup(
  contents: PopupContentsLike,
  log: (level: 'info' | 'warn', message: string, data?: Record<string, unknown>) => void = () => undefined
): Promise<boolean> {
  try {
    if (contents.isDestroyed()) return false;
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
    // The Page domain must be enabled for new-document scripts to be delivered (measured: without it the script registers and never runs).
    await contents.debugger.sendCommand('Page.enable');
    await contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: HIDE_PASSKEYS_SCRIPT });
    contents.once('destroyed', () => {
      try {
        if (contents.debugger.isAttached()) contents.debugger.detach();
      } catch {
        /* already gone */
      }
    });
    log('info', 'popup: passkeys hidden from google.com documents', {});
    return true;
  } catch (err) {
    log('warn', 'popup: could not hide passkeys (popup still works, passkey step may appear)', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Adapts a real `WebContents` to the seam. */
export function popupContents(contents: WebContents): PopupContentsLike {
  return contents as unknown as PopupContentsLike;
}
