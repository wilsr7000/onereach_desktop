/**
 * QR-code scanner for TOTP setup.
 *
 * Captures the screen (or reads the clipboard image), decodes any QR
 * code via `jsqr`, returns the decoded string. Caller passes that
 * string to `parseOtpAuthUri` from `./manager.ts` to get the secret.
 *
 * Borrowed pattern (studied, never imported): `lib/qr-scanner.js`.
 * Rewritten in TS-strict.
 *
 * `desktopCapturer` is a main-process Electron API and prompts the
 * user for screen-recording permission on macOS at first use. If
 * denied, the call returns no sources or an empty thumbnail; the
 * caller surfaces a `TOTP_SCREEN_CAPTURE_FAILED` error and falls back
 * to clipboard or manual entry.
 *
 * @internal
 */

import {
  clipboard as electronClipboard,
  desktopCapturer as electronDesktopCapturer,
  screen as electronScreen,
  type DesktopCapturerSource,
  type NativeImage,
} from 'electron';
import { TotpError, TOTP_ERROR_CODES } from './errors.js';

// jsqr is externalized in esbuild; load lazily to keep unit tests
// (which mock the module) from blowing up on import.
interface JsqrFn {
  (data: Uint8ClampedArray, width: number, height: number): { data: string } | null;
}

let _jsqr: JsqrFn | null = null;

function loadJsqr(): JsqrFn {
  if (_jsqr === null) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const mod = require('jsqr') as JsqrFn | { default: JsqrFn };
    _jsqr = typeof mod === 'function' ? mod : mod.default;
  }
  return _jsqr;
}

/** @internal -- exposed for tests so they can inject a stub jsqr. */
export function _setJsqrForTesting(stub: JsqrFn | null): void {
  _jsqr = stub;
}

// ---------------------------------------------------------------------------
// Optional dependency-injection for tests
// ---------------------------------------------------------------------------

export interface DesktopCapturerLike {
  getSources(opts: { types: ('screen' | 'window')[]; thumbnailSize: { width: number; height: number } }): Promise<DesktopCapturerSource[]>;
}

export interface ScreenLike {
  getPrimaryDisplay(): { workAreaSize: { width: number; height: number }; scaleFactor?: number; id: number };
  getDisplayNearestPoint(point: { x: number; y: number }): { workAreaSize: { width: number; height: number }; scaleFactor?: number; id: number };
}

export interface ClipboardLike {
  readImage(): NativeImage;
}

export interface QrScannerConfig {
  desktopCapturer?: DesktopCapturerLike;
  screen?: ScreenLike;
  clipboard?: ClipboardLike;
  logger?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

export class QrScanner {
  private readonly desktopCapturer: DesktopCapturerLike;
  private readonly screen: ScreenLike;
  private readonly clipboard: ClipboardLike;
  private readonly log: NonNullable<QrScannerConfig['logger']>;

  constructor(config: QrScannerConfig = {}) {
    this.desktopCapturer = config.desktopCapturer ?? (electronDesktopCapturer as DesktopCapturerLike);
    this.screen = config.screen ?? (electronScreen as unknown as ScreenLike);
    this.clipboard = config.clipboard ?? (electronClipboard as unknown as ClipboardLike);
    this.log =
      config.logger ??
      ((): void => {
        /* default: silent */
      });
  }

  /**
   * Scan the user's screen for a QR code. Returns the decoded string
   * (typically an `otpauth://` URI). Returns null if no QR was found.
   *
   * @throws {TotpError} `TOTP_SCREEN_CAPTURE_FAILED` if the screen
   *   capture itself failed (permission denied, no displays, etc.).
   */
  async scanFromScreen(): Promise<string | null> {
    let display: { workAreaSize: { width: number; height: number }; scaleFactor?: number; id: number };
    try {
      display = this.screen.getPrimaryDisplay();
    } catch (err) {
      throw new TotpError({
        code: TOTP_ERROR_CODES.SCREEN_CAPTURE_FAILED,
        message: 'Could not enumerate displays for screen capture.',
        cause: err,
        remediation: 'Try again, or paste the secret manually.',
      });
    }
    const { width, height } = display.workAreaSize;
    const scaleFactor = display.scaleFactor ?? 1;

    let sources: DesktopCapturerSource[];
    try {
      sources = await this.desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.floor(width * scaleFactor),
          height: Math.floor(height * scaleFactor),
        },
      });
    } catch (err) {
      throw new TotpError({
        code: TOTP_ERROR_CODES.SCREEN_CAPTURE_FAILED,
        message: 'Screen capture failed.',
        context: { displayId: display.id },
        cause: err,
        remediation:
          'On macOS, grant Screen Recording permission to Onereach.ai Lite in System Settings -> Privacy & Security. Then restart the app and try again. Or paste the secret manually.',
      });
    }

    if (sources.length === 0) {
      this.log('warn', 'totp-qr: no screen sources returned', { displayId: display.id });
      throw new TotpError({
        code: TOTP_ERROR_CODES.SCREEN_CAPTURE_FAILED,
        message: 'No screen sources returned by the OS.',
        context: { displayId: display.id },
        remediation:
          'On macOS, this usually means Screen Recording permission was denied. Grant it in System Settings -> Privacy & Security and restart the app.',
      });
    }

    const screenSource =
      sources.find((s) => String(s.display_id) === String(display.id)) ?? sources[0];
    if (screenSource === undefined) {
      throw new TotpError({
        code: TOTP_ERROR_CODES.SCREEN_CAPTURE_FAILED,
        message: 'Could not select a screen source.',
        context: {},
      });
    }
    const thumbnail = screenSource.thumbnail;
    if (thumbnail.isEmpty()) {
      throw new TotpError({
        code: TOTP_ERROR_CODES.SCREEN_CAPTURE_FAILED,
        message: 'Screen capture returned an empty image.',
        context: {},
        remediation:
          'On macOS, grant Screen Recording permission and restart the app.',
      });
    }

    return this.scanNativeImage(thumbnail);
  }

  /**
   * Scan an image currently on the clipboard.
   *
   * Returns null if the clipboard has no image OR no QR was found.
   * Does NOT throw `TOTP_NO_QR_FOUND` -- empty clipboard is a normal
   * "nothing here" outcome, not an error.
   */
  async scanFromClipboard(): Promise<string | null> {
    const image = this.clipboard.readImage();
    if (image.isEmpty()) {
      this.log('info', 'totp-qr: clipboard has no image', {});
      return null;
    }
    return this.scanNativeImage(image);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private scanNativeImage(image: NativeImage): string | null {
    const { width, height } = image.getSize();
    if (width === 0 || height === 0) return null;
    const bgra = image.toBitmap();
    const rgba = bgraToRgba(bgra);
    const jsqr = loadJsqr();
    const result = jsqr(rgba, width, height);
    if (result === null) {
      this.log('info', 'totp-qr: no QR found in image', { width, height });
      return null;
    }
    this.log('info', 'totp-qr: QR found', { width, height, dataLength: result.data.length });
    return result.data;
  }
}

/**
 * Convert BGRA buffer (Electron's `toBitmap()` output) to RGBA
 * (`jsqr`'s expected input). Pure helper, exported for tests.
 */
export function bgraToRgba(bgra: Buffer | Uint8Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) {
    out[i] = bgra[i + 2] ?? 0;
    out[i + 1] = bgra[i + 1] ?? 0;
    out[i + 2] = bgra[i] ?? 0;
    out[i + 3] = bgra[i + 3] ?? 0;
  }
  return out;
}
