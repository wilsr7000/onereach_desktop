/**
 * Event bus errors -- structured errors thrown by the bus's IPC and
 * persistence paths.
 *
 * Codes are namespaced with the `EB_` prefix.
 */

import { LiteError } from '../errors.js';
import type { LiteErrorOptions } from '../errors.js';

export const EVENT_BUS_ERROR_CODES = {
  /** Caller passed a domain event name that isn't in the catalogue. */
  UNKNOWN_NAME: 'EB_UNKNOWN_NAME',
  /** Subscriber payload failed validation (renderer-side). */
  INVALID_INPUT: 'EB_INVALID_INPUT',
  /** Underlying KV write rejected. Bus stays operational; persistence
   *  is best-effort -- in-memory state is still authoritative. */
  PERSISTENCE_FAILED: 'EB_PERSISTENCE_FAILED',
} as const;

export type EventBusErrorCode =
  (typeof EVENT_BUS_ERROR_CODES)[keyof typeof EVENT_BUS_ERROR_CODES];

export interface EventBusErrorOptions extends Omit<LiteErrorOptions, 'code'> {
  code: EventBusErrorCode;
}

export class EventBusError extends LiteError {
  constructor(options: EventBusErrorOptions) {
    const baseOptions: LiteErrorOptions = {
      code: options.code,
      message: options.message,
      ...(options.context !== undefined ? { context: options.context } : {}),
      ...(options.remediation !== undefined ? { remediation: options.remediation } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    };
    super(baseOptions);
    this.name = 'EventBusError';
  }
}
