/** Calendar errors (ADR-090) — typed code, plain message, a remediation the UI can show. */
import type { CalendarErrorCode } from './types.js';

export class CalendarError extends Error {
  status: number | null = null;
  constructor(
    public readonly code: CalendarErrorCode,
    message: string,
    public readonly remediation: string = ''
  ) {
    super(message);
    this.name = 'CalendarError';
  }
}
