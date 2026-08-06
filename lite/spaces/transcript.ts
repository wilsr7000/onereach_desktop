/**
 * Transcript detection + Markdown conversion.
 *
 * Meeting/voice transcripts arrive in Spaces two ways — pasted into
 * the "Paste text" tab or uploaded as a file (.vtt / .srt / .txt
 * exports). Raw transcripts render terribly as prose, so intake
 * detects them and converts to a consistent Markdown shape the
 * existing renderer already handles well:
 *
 *   **Participants:** Alice, Bob
 *
 *   **Alice** · *00:00:05*
 *
 *   Hello everyone…
 *
 * Supported source shapes:
 *   - `vtt`            — WEBVTT subtitle/caption files (incl. Teams
 *                        exports and `<v Speaker>` voice spans)
 *   - `srt`            — SubRip blocks (`1` / `00:00:00,000 --> …`)
 *   - `speaker-lines`  — `Name: text` dialogue, with optional leading
 *                        `[00:12:34]` / `00:12` timestamps (Zoom-ish)
 *   - `speaker-blocks` — `Name  0:12` header line, text below (Otter-ish)
 *
 * Detection is deliberately conservative for the free-text shapes —
 * YAML, JSON, code, and ordinary prose must never convert — so it
 * requires multiple turns, repeated speakers, and a high match ratio.
 * VTT/SRT headers are definitive.
 *
 * Pure; no DOM/Electron imports. Unit-tested directly.
 */

export type TranscriptFormat = 'vtt' | 'srt' | 'speaker-lines' | 'speaker-blocks';

export interface TranscriptTurn {
  speaker: string | null;
  /** Normalized `hh:mm:ss` / `mm:ss` (ms stripped); null when absent. */
  time: string | null;
  text: string;
}

export interface TranscriptConversion {
  format: TranscriptFormat;
  markdown: string;
  /** Distinct speaker names in first-appearance order (may be empty). */
  speakers: string[];
  turnCount: number;
}

// ─── Shared patterns ────────────────────────────────────────────────────

/** `00:00:00.000` / `00:00.000` / `00:00:00,000` cue timestamps. */
const CUE_TIME = String.raw`(?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{3}`;
const CUE_LINE_RE = new RegExp(`^\\s*(${CUE_TIME})\\s+-->\\s+(${CUE_TIME})`);

/** Human-typed timestamps: `12:34`, `1:02:33`, optionally bracketed. */
const CLOCK = String.raw`\d{1,2}:\d{2}(?::\d{2})?`;

/**
 * A "speaker name": 1–4 word-ish tokens, letters first, no quotes /
 * braces / slashes (kills JSON + paths), ≤ 40 chars total.
 */
const NAME = String.raw`[A-Za-z][\w.'-]*(?:[ \t][A-Za-z][\w.'-]*){0,3}`;

const SPEAKER_LINE_RE = new RegExp(
  `^\\s*(?:[\\[(]?(${CLOCK})[\\])]?[ \\t]+)?(${NAME})[ \\t]*:[ \\t]+(\\S.*)$`
);

const SPEAKER_BLOCK_HEAD_RE = new RegExp(`^\\s*(${NAME})[ \\t]+(${CLOCK})\\s*$`);

/** Strip trailing milliseconds from a cue timestamp. */
function normalizeTime(t: string | null | undefined): string | null {
  if (typeof t !== 'string' || t.length === 0) return null;
  return t.replace(/[.,]\d{1,3}$/, '');
}

// ─── Detection ──────────────────────────────────────────────────────────

/** Detect the transcript shape, or null when the text isn't one. */
export function detectTranscriptFormat(text: string): TranscriptFormat | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  if (/^WEBVTT\b/.test(trimmed)) return 'vtt';

  const lines = trimmed.split(/\r?\n/);
  const nonBlank = lines.filter((l) => l.trim().length > 0);
  if (nonBlank.length < 4) return null;

  // SRT: a numeric index line immediately followed by a cue-time line,
  // seen at least twice.
  let srtBlocks = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^\s*\d+\s*$/.test(lines[i] ?? '') && CUE_LINE_RE.test(lines[i + 1] ?? '')) {
      srtBlocks++;
    }
  }
  if (srtBlocks >= 2) return 'srt';

  // Free-text shapes need strong evidence: enough matches, a high
  // ratio, ≥2 distinct speakers, and at least one speaker repeating
  // (kills YAML/config where "keys" rarely repeat).
  const evaluate = (
    matches: Array<string>
  ): boolean => {
    if (matches.length < 4) return false;
    if (matches.length / nonBlank.length < 0.4) return false;
    const counts = new Map<string, number>();
    for (const name of matches) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    if (counts.size < 2 || counts.size > 24) return false;
    let maxRepeat = 0;
    for (const n of counts.values()) maxRepeat = Math.max(maxRepeat, n);
    return maxRepeat >= 2;
  };

  const lineSpeakers: string[] = [];
  for (const l of nonBlank) {
    const m = SPEAKER_LINE_RE.exec(l);
    if (m?.[2] !== undefined) lineSpeakers.push(m[2]);
  }
  if (evaluate(lineSpeakers)) return 'speaker-lines';

  const blockSpeakers: string[] = [];
  for (const l of nonBlank) {
    const m = SPEAKER_BLOCK_HEAD_RE.exec(l);
    if (m?.[1] !== undefined) blockSpeakers.push(m[1]);
  }
  // Block headers alternate with body text, so the ratio bar is lower.
  if (
    blockSpeakers.length >= 3 &&
    blockSpeakers.length / nonBlank.length >= 0.2 &&
    evaluate([...blockSpeakers, ...blockSpeakers.slice(0, 1)]) // reuse repeat/distinct rules
  ) {
    return 'speaker-blocks';
  }

  return null;
}

// ─── Parsers (source → turns) ───────────────────────────────────────────

function stripVttTags(s: string): string {
  return s.replace(/<[^>]*>/g, '').trim();
}

function parseVtt(text: string): TranscriptTurn[] {
  const lines = text.split(/\r?\n/);
  const turns: TranscriptTurn[] = [];
  let i = 0;
  while (i < lines.length) {
    const cue = CUE_LINE_RE.exec(lines[i] ?? '');
    if (cue === null) {
      i++;
      continue;
    }
    const time = normalizeTime(cue[1]);
    i++;
    const body: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim().length > 0) {
      body.push((lines[i] ?? '').trim());
      i++;
    }
    const joined = body.join(' ');
    const voice = /<v\s+([^>]+)>/.exec(joined);
    const speaker = voice?.[1]?.trim() ?? null;
    const textOut = stripVttTags(joined);
    if (textOut.length > 0) {
      turns.push({ speaker, time, text: textOut });
    }
  }
  return turns;
}

function parseSpeakerLines(text: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const m = SPEAKER_LINE_RE.exec(line);
    if (m === null) {
      // Continuation of the previous turn.
      const prev = turns[turns.length - 1];
      if (prev !== undefined) prev.text += ` ${line}`;
      continue;
    }
    turns.push({
      speaker: m[2] ?? null,
      time: normalizeTime(m[1] ?? null),
      text: (m[3] ?? '').trim(),
    });
  }
  return turns;
}

function parseSpeakerBlocks(text: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let current: TranscriptTurn | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const head = SPEAKER_BLOCK_HEAD_RE.exec(line);
    if (head !== null) {
      if (current !== null && current.text.length > 0) turns.push(current);
      current = {
        speaker: head[1] ?? null,
        time: normalizeTime(head[2] ?? null),
        text: '',
      };
      continue;
    }
    if (current === null) continue; // preamble before the first header
    current.text = current.text.length === 0 ? line : `${current.text} ${line}`;
  }
  if (current !== null && current.text.length > 0) turns.push(current);
  return turns;
}

// ─── Markdown emission ──────────────────────────────────────────────────

/** Merge consecutive same-speaker turns; group speakerless cues. */
function coalesceTurns(turns: TranscriptTurn[]): TranscriptTurn[] {
  const out: TranscriptTurn[] = [];
  for (const t of turns) {
    const prev = out[out.length - 1];
    const sameSpeaker =
      prev !== undefined && prev.speaker !== null && prev.speaker === t.speaker;
    const bothAnon =
      prev !== undefined &&
      prev.speaker === null &&
      t.speaker === null &&
      prev.text.length < 350;
    if (sameSpeaker || bothAnon) {
      if (prev !== undefined) prev.text += ` ${t.text}`;
      continue;
    }
    out.push({ ...t });
  }
  return out;
}

function turnsToMarkdown(turns: TranscriptTurn[], speakers: string[]): string {
  const parts: string[] = [];
  if (speakers.length > 0) {
    parts.push(`**Participants:** ${speakers.join(', ')}`);
  }
  for (const t of turns) {
    const time = t.time !== null ? ` · *${t.time}*` : '';
    if (t.speaker !== null) {
      parts.push(`**${t.speaker}**${time}\n\n${t.text}`);
    } else if (t.time !== null) {
      parts.push(`*${t.time}*\n\n${t.text}`);
    } else {
      parts.push(t.text);
    }
  }
  return parts.join('\n\n');
}

/**
 * Detect + parse + convert in one step. Returns null when the text is
 * not a transcript (callers store it untouched) or when parsing yields
 * fewer than 2 usable turns (detection false-positive guard).
 */
export function convertTranscript(text: string): TranscriptConversion | null {
  const format = detectTranscriptFormat(text);
  if (format === null) return null;
  let turns: TranscriptTurn[];
  switch (format) {
    case 'vtt':
    case 'srt':
      turns = parseVtt(text); // SRT cues parse with the same cue scanner
      break;
    case 'speaker-lines':
      turns = parseSpeakerLines(text);
      break;
    case 'speaker-blocks':
      turns = parseSpeakerBlocks(text);
      break;
  }
  turns = coalesceTurns(turns);
  // Definitive container formats (VTT/SRT headers) convert even when
  // coalescing folds everything into one block; the free-text shapes
  // keep the ≥2-turn guard against detection false positives.
  const minTurns = format === 'vtt' || format === 'srt' ? 1 : 2;
  if (turns.length < minTurns) return null;
  const speakers: string[] = [];
  for (const t of turns) {
    if (t.speaker !== null && !speakers.includes(t.speaker)) speakers.push(t.speaker);
  }
  return {
    format,
    markdown: turnsToMarkdown(turns, speakers),
    speakers,
    turnCount: turns.length,
  };
}

// ─── Tile-side parsing (converted md → preview rows) ────────────────────

export interface TranscriptTilePreviewData {
  participants: string[];
  turns: Array<{ speaker: string; text: string }>;
}

/**
 * Parse the converted-Markdown HEAD (summaries carry ~280 chars) back
 * into rows for the transcript tile: the participants line plus the
 * first speaker turns. Tolerant of a truncated tail — a half turn at
 * the cut is dropped.
 */
export function parseTranscriptTilePreview(
  mdHead: string | undefined
): TranscriptTilePreviewData {
  const empty: TranscriptTilePreviewData = { participants: [], turns: [] };
  if (typeof mdHead !== 'string' || mdHead.trim().length === 0) return empty;
  // Summaries cap contentHead at 280 chars — at (or near) the cap the
  // tail is almost certainly cut mid-turn. Short heads are complete.
  const truncated = mdHead.length >= 278;
  const blocks = mdHead.split(/\n{2,}/);
  const participants: string[] = [];
  const turns: Array<{ speaker: string; text: string }> = [];
  let pendingSpeaker: string | null = null;
  for (const raw of blocks) {
    const block = raw.trim();
    if (block.length === 0) continue;
    const pm = /^\*\*Participants:\*\*\s*(.+)$/.exec(block);
    if (pm !== null) {
      for (const name of (pm[1] ?? '').split(',')) {
        const n = name.trim();
        if (n.length > 0) participants.push(n);
      }
      continue;
    }
    const sm = /^\*\*([^*]+)\*\*(?:\s*·\s*\*[^*]*\*)?$/.exec(block);
    if (sm !== null) {
      pendingSpeaker = (sm[1] ?? '').trim();
      continue;
    }
    if (pendingSpeaker !== null) {
      turns.push({ speaker: pendingSpeaker, text: block });
      pendingSpeaker = null;
    }
  }
  // Drop a final turn whose text was cut mid-word by the summary cap.
  if (truncated && turns.length > 1) {
    turns.pop();
  }
  return { participants, turns };
}
