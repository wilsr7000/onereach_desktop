/**
 * Onboarding main-process orchestration.
 *
 * Owns IPC handlers for `lite:onboarding:*`. Mirrors the Lite
 * module convention: thin IPC glue, real logic in `store.ts`.
 *
 * @internal
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { getOnboardingApi } from './api.js';
import {
  ONBOARDING_STEP_IDS,
  type OnboardingState,
  type OnboardingStepId,
} from './types.js';

export const ONBOARDING_IPC = {
  LOAD: 'lite:onboarding:load',
  MARK_COMPLETE: 'lite:onboarding:mark-complete',
  DISMISS: 'lite:onboarding:dismiss',
} as const;

export interface OnboardingHandle {
  teardown(): void;
}

let registered = false;

export function initOnboarding(): OnboardingHandle {
  if (registered) return { teardown: teardownInternal };
  const api = getOnboardingApi();

  ipcMain.handle(ONBOARDING_IPC.LOAD, async (): Promise<OnboardingState> => {
    return api.load();
  });

  ipcMain.handle(
    ONBOARDING_IPC.MARK_COMPLETE,
    async (
      _event: IpcMainInvokeEvent,
      payload: { stepId?: unknown }
    ): Promise<OnboardingState> => {
      if (typeof payload?.stepId !== 'string') {
        throw new Error('stepId must be a string');
      }
      if (!(ONBOARDING_STEP_IDS as readonly string[]).includes(payload.stepId)) {
        throw new Error(`Unknown onboarding step id: ${payload.stepId}`);
      }
      return api.markComplete(payload.stepId as OnboardingStepId);
    }
  );

  ipcMain.handle(ONBOARDING_IPC.DISMISS, async (): Promise<OnboardingState> => {
    return api.dismiss();
  });

  registered = true;
  return { teardown: teardownInternal };
}

function teardownInternal(): void {
  if (!registered) return;
  for (const ch of Object.values(ONBOARDING_IPC)) {
    try {
      ipcMain.removeHandler(ch);
    } catch {
      /* best-effort */
    }
  }
  registered = false;
}

/** @internal -- exposed for tests. */
export function _isOnboardingRegisteredForTesting(): boolean {
  return registered;
}
