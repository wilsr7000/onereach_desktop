import { describe, it, expect } from 'vitest';
import {
  detectTranscriptFormat,
  convertTranscript,
  parseTranscriptTilePreview,
} from '../../spaces/transcript.js';

const VTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
<v Alice Smith>Hello everyone, thanks for joining.</v>

00:00:04.500 --> 00:00:07.000
<v Bob>Happy to be here.</v>

00:00:07.500 --> 00:00:11.000
<v Alice Smith>Let's start with the pilot update.</v>
`;

const SRT = `1
00:00:01,000 --> 00:00:04,000
Hello everyone, thanks for joining.

2
00:00:04,500 --> 00:00:07,000
Happy to be here.

3
00:00:08,000 --> 00:00:10,000
Let's dive in.
`;

const SPEAKER_LINES = `Alice: Hello everyone, thanks for joining today.
Bob: Happy to be here, excited to see the demo.
Alice: Let's start with the pilot update.
Bob: The numbers look strong this week.
Alice: Great, let's walk through them.
`;

const ZOOM_STYLE = `[00:00:05] Alice: Hello everyone, thanks for joining.
[00:00:12] Bob: Happy to be here.
[00:00:18] Alice: Let's start with the pilot update.
[00:00:25] Bob: Sounds good.
`;

const OTTER_BLOCKS = `Alice Smith  0:05
Hello everyone, thanks for joining today's session.

Bob Jones  0:12
Happy to be here. Excited for the demo.

Alice Smith  0:20
Let's start with the pilot update.
`;

describe('detectTranscriptFormat', () => {
  it('detects VTT, SRT, speaker-lines, zoom-style, and speaker-blocks', () => {
    expect(detectTranscriptFormat(VTT)).toBe('vtt');
    expect(detectTranscriptFormat(SRT)).toBe('srt');
    expect(detectTranscriptFormat(SPEAKER_LINES)).toBe('speaker-lines');
    expect(detectTranscriptFormat(ZOOM_STYLE)).toBe('speaker-lines');
    expect(detectTranscriptFormat(OTTER_BLOCKS)).toBe('speaker-blocks');
  });

  it('rejects YAML (keys do not repeat)', () => {
    const yaml = `name: Support Bot
kind: conversational
model: claude
channels: web
timeout: 30
retries: 2`;
    expect(detectTranscriptFormat(yaml)).toBeNull();
  });

  it('rejects JSON, prose, markdown, and short dialogues', () => {
    expect(
      detectTranscriptFormat('{"alice": "hello", "bob": "world", "alice2": "x"}')
    ).toBeNull();
    expect(
      detectTranscriptFormat(
        'This is a normal paragraph of prose.\nIt has lines.\nNo speakers here.\nJust text.\nMore text.'
      )
    ).toBeNull();
    expect(
      detectTranscriptFormat('# Title\n\nSome markdown body.\n\n- a list\n- of things')
    ).toBeNull();
    expect(detectTranscriptFormat('Alice: hi\nBob: hey')).toBeNull();
    expect(detectTranscriptFormat('')).toBeNull();
  });
});

describe('convertTranscript', () => {
  it('converts VTT with voice spans: participants, bold speakers, times', () => {
    const r = convertTranscript(VTT);
    expect(r).not.toBeNull();
    expect(r?.format).toBe('vtt');
    expect(r?.speakers).toEqual(['Alice Smith', 'Bob']);
    expect(r?.markdown).toContain('**Participants:** Alice Smith, Bob');
    expect(r?.markdown).toContain('**Alice Smith** · *00:00:01*');
    expect(r?.markdown).toContain('Hello everyone, thanks for joining.');
    expect(r?.markdown).not.toContain('<v');
    expect(r?.markdown).not.toContain('-->');
  });

  it('converts SRT without speakers: timestamped merged blocks, no participants line', () => {
    const r = convertTranscript(SRT);
    expect(r).not.toBeNull();
    expect(r?.format).toBe('srt');
    expect(r?.speakers).toEqual([]);
    expect(r?.markdown).not.toContain('Participants');
    expect(r?.markdown).toContain('*00:00:01*');
    expect(r?.markdown).toContain('Hello everyone');
  });

  it('converts speaker lines and merges consecutive same-speaker turns', () => {
    const doubled = `Alice: First thought.
Alice: Second thought continues.
Bob: A reply arrives here.
Alice: Closing remark now.
Bob: Final word said.`;
    const r = convertTranscript(doubled);
    expect(r).not.toBeNull();
    expect(r?.turnCount).toBe(4); // Alice's first two merged
    expect(r?.markdown).toContain('First thought. Second thought continues.');
  });

  it('keeps zoom-style leading timestamps on the turn', () => {
    const r = convertTranscript(ZOOM_STYLE);
    expect(r).not.toBeNull();
    expect(r?.markdown).toContain('**Alice** · *00:00:05*');
  });

  it('converts Otter-style blocks with times', () => {
    const r = convertTranscript(OTTER_BLOCKS);
    expect(r).not.toBeNull();
    expect(r?.format).toBe('speaker-blocks');
    expect(r?.speakers).toEqual(['Alice Smith', 'Bob Jones']);
    expect(r?.markdown).toContain('**Bob Jones** · *0:12*');
    expect(r?.markdown).toContain("thanks for joining today's session.");
  });

  it('returns null for non-transcripts (storage untouched)', () => {
    expect(convertTranscript('Just some prose.\nNothing else.\nAt all.\nReally.')).toBeNull();
  });
});

describe('parseTranscriptTilePreview', () => {
  const md = `**Participants:** Alice, Bob

**Alice** · *00:00:05*

Hello everyone, thanks for joining.

**Bob** · *00:00:12*

Happy to be here.`;

  it('parses participants and speaker turns from a complete head', () => {
    const p = parseTranscriptTilePreview(md);
    expect(p.participants).toEqual(['Alice', 'Bob']);
    expect(p.turns).toEqual([
      { speaker: 'Alice', text: 'Hello everyone, thanks for joining.' },
      { speaker: 'Bob', text: 'Happy to be here.' },
    ]);
  });

  it('drops the trailing half-turn of a cap-truncated head', () => {
    const cut = (md + '\n\n**Alice** · *00:00:20*\n\nAnd one more thi').slice(0, 280);
    const p = parseTranscriptTilePreview(cut.padEnd(280, 'x'));
    expect(p.turns.length).toBeGreaterThanOrEqual(1);
    const last = p.turns[p.turns.length - 1];
    expect(last?.text.endsWith('thi')).toBe(false);
  });

  it('returns empty shapes for blank/undefined input', () => {
    expect(parseTranscriptTilePreview(undefined)).toEqual({ participants: [], turns: [] });
    expect(parseTranscriptTilePreview('   ')).toEqual({ participants: [], turns: [] });
  });
});
