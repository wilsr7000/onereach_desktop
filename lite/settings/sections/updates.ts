/**
 * Settings → Updates: version, updater status, manual check, and the
 * last install attempt's trail.
 *
 * Replaces the placeholder (2026-08-07 reporting review: "Updates
 * still thin"). Same conventions as the other sections: self-mounting,
 * returns a disposer, talks only through the preload bridge
 * (`window.lite.updater` + the app version from `window.lite.meta`).
 */

interface SettingsUpdaterState {
  failedAttempts: number;
  lastAttemptVersion: string | null;
  lastAttemptTime: string | null;
}

interface SettingsUpdaterBridge {
  check(opts?: { manual?: boolean }): Promise<{ inFlight: boolean; timedOut: boolean; manual: boolean }>;
  getState(): Promise<SettingsUpdaterState>;
  onStatus(listener: (event: { status: string; info?: unknown }) => void): () => void;
}

// `window.updater` is exposed by the kernel preload; only this section
// uses it in the settings renderer, so it is declared here (same
// convention as window.bugReport in lite/bug-report/modal.ts).
declare global {
  interface Window {
    updater: SettingsUpdaterBridge;
  }
}

export function mountUpdates(container: HTMLElement): (() => void) | undefined {
  const wrap = document.createElement('div');
  wrap.className = 'updates-pane';

  const intro = document.createElement('p');
  intro.className = 'pane-intro';
  intro.textContent =
    'Lite checks for updates automatically every 6 hours and installs on your say-so. Updates are signed; install failures are tracked across restarts.';
  wrap.appendChild(intro);

  // ── Current version ──────────────────────────────────────────────
  const versionRow = document.createElement('div');
  versionRow.className = 'updates-row';
  const versionLabel = document.createElement('span');
  versionLabel.className = 'updates-label';
  versionLabel.textContent = 'Current version';
  versionRow.appendChild(versionLabel);
  const versionValue = document.createElement('span');
  versionValue.className = 'updates-value';
  versionValue.textContent = window.lite?.version ?? 'unknown';
  versionRow.appendChild(versionValue);
  wrap.appendChild(versionRow);

  // ── Status line + manual check ───────────────────────────────────
  const statusRow = document.createElement('div');
  statusRow.className = 'updates-row';
  const statusLabel = document.createElement('span');
  statusLabel.className = 'updates-label';
  statusLabel.textContent = 'Status';
  statusRow.appendChild(statusLabel);
  const statusValue = document.createElement('span');
  statusValue.className = 'updates-value';
  statusValue.id = 'settings-updates-status';
  statusValue.textContent = 'Idle — next automatic check within 6 hours.';
  statusRow.appendChild(statusValue);
  wrap.appendChild(statusRow);

  const checkBtn = document.createElement('button');
  checkBtn.type = 'button';
  checkBtn.className = 'updates-check-btn';
  checkBtn.id = 'settings-updates-check';
  checkBtn.textContent = 'Check for Updates';
  wrap.appendChild(checkBtn);

  const describeStatus = (payload: { status: string }): string => {
    switch (payload.status) {
      case 'checking':
        return 'Checking…';
      case 'available':
      case 'downloading':
      case 'progress':
        return 'Update available — downloading.';
      case 'downloaded':
        return 'Update downloaded — restart to install.';
      case 'not-available':
        return 'Up to date.';
      case 'installing':
        return 'Installing…';
      case 'error':
        return 'Update check failed — see logs.';
      default:
        return 'Idle — next automatic check within 6 hours.';
    }
  };

  const updater = typeof window.updater !== 'undefined' ? window.updater : undefined;
  let unsubscribe: (() => void) | undefined;
  if (updater !== undefined) {
    unsubscribe = updater.onStatus((payload) => {
      statusValue.textContent = describeStatus(payload);
    });
    checkBtn.addEventListener('click', () => {
      checkBtn.disabled = true;
      statusValue.textContent = 'Checking…';
      void updater
        .check({ manual: true })
        .then((res) => {
          // A status event drives the normal outcome; but if a check
          // was already in flight (or timed out) no new terminal event
          // fires, so recover the line from the call result rather than
          // leaving it stuck on "Checking…" (2026-08-08 sweep).
          if (res.inFlight) statusValue.textContent = 'A check is already running…';
          else if (res.timedOut) statusValue.textContent = 'Check timed out — try again.';
        })
        .catch(() => {
          statusValue.textContent = 'Update check failed — see logs.';
        })
        .finally(() => {
          checkBtn.disabled = false;
        });
    });
  } else {
    checkBtn.disabled = true;
    statusValue.textContent = 'Updater bridge unavailable.';
  }

  // ── Last install attempt (cross-restart trail) ───────────────────
  const attemptBlock = document.createElement('div');
  attemptBlock.className = 'updates-attempt';
  attemptBlock.id = 'settings-updates-attempt';
  wrap.appendChild(attemptBlock);

  void (async () => {
    try {
      const state = await updater?.getState();
      if (state === undefined) return;
      if (state.lastAttemptVersion === null) {
        attemptBlock.textContent = 'No update install has been attempted on this Mac.';
        return;
      }
      const when =
        state.lastAttemptTime !== null
          ? (() => {
              const d = new Date(state.lastAttemptTime);
              return Number.isNaN(d.getTime())
                ? state.lastAttemptTime
                : d.toLocaleString();
            })()
          : null;
      const lines: string[] = [
        `Last install attempt: v${state.lastAttemptVersion}` +
          (when !== null ? ` at ${when}` : ''),
      ];
      if (state.failedAttempts > 0) {
        lines.push(
          `Failed ${state.failedAttempts} time${state.failedAttempts === 1 ? '' : 's'} — ` +
            'the boot check will offer to file a bug report with this trail.'
        );
      }
      attemptBlock.textContent = lines.join('\n');
    } catch {
      attemptBlock.textContent = '';
    }
  })();

  container.appendChild(wrap);
  return (): void => {
    unsubscribe?.();
    wrap.remove();
  };
}
