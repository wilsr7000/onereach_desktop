/**
 * Convert events (ADR-030 taxonomy, ADR-100). One span per run: start,
 * finish, fail — with the formats, the pipeline, and the byte counts.
 */

import type { EventRecord, SerializedEventError } from '../logging/events.js';

export const CONVERT_EVENTS = {
  RUN_START: 'convert.run.start',
  RUN_FINISH: 'convert.run.finish',
  RUN_FAIL: 'convert.run.fail',
} as const;

export type ConvertEventName = (typeof CONVERT_EVENTS)[keyof typeof CONVERT_EVENTS];

interface ConvertEventBase {
  id: string;
  timestamp: string;
  category: 'convert';
  spanId: string;
}

export interface ConvertRunStartData {
  from: string;
  to: string;
  inputBytes: number;
  strategy?: string;
}

export interface ConvertRunFinishData extends ConvertRunStartData {
  pipeline: string[];
  outputBytes: number;
  durationMs: number;
  warnings: number;
}

export interface ConvertRunFailData extends ConvertRunStartData {
  durationMs: number;
  error: SerializedEventError;
}

export type ConvertEvent =
  | (ConvertEventBase & { name: typeof CONVERT_EVENTS.RUN_START; data: ConvertRunStartData })
  | (ConvertEventBase & { name: typeof CONVERT_EVENTS.RUN_FINISH; data: ConvertRunFinishData })
  | (ConvertEventBase & { name: typeof CONVERT_EVENTS.RUN_FAIL; data: ConvertRunFailData });

const NAMES: ReadonlySet<string> = new Set(Object.values(CONVERT_EVENTS));

/** Type guard: is this raw event record one of ours? */
export function isConvertEvent(record: EventRecord): record is EventRecord & ConvertEvent {
  return NAMES.has(record.name);
}
