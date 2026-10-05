import { describe, expect, it } from 'vitest';
import * as p from '../../src/protocol.ts';
import fixture from '../fixtures/old-contract.json' with { type: 'json' };

describe('contract matches the old repo', () => {
  it('sentinels', () => {
    const { CONVERSATION_ENDED, NO_SPEECH, LISTEN_CONTINUES, STOPPED, BACKGROUND_RESULT } = p;
    expect({ CONVERSATION_ENDED, NO_SPEECH, LISTEN_CONTINUES, STOPPED, BACKGROUND_RESULT }).toEqual(fixture.sentinels);
    expect(p.SENTINELS).toHaveLength(6);
  });
  it('notes word for word', () => {
    const { ENDED_NOTE, NO_SPEECH_NOTE, CONTINUES_NOTE, NO_SLEEP_NOTE, TURN_NOTE } = p;
    expect({ ENDED_NOTE, NO_SPEECH_NOTE, CONTINUES_NOTE, NO_SLEEP_NOTE, TURN_NOTE }).toEqual(fixture.notes);
  });
  it('tool descriptions contain every note and sentinel', () => {
    expect(p.STT_DESCRIPTION).toBe(fixture.sttDescription);
    expect(p.TTS_DESCRIPTION).toBe(fixture.ttsDescription);
    for (const d of [p.STT_DESCRIPTION, p.TTS_DESCRIPTION]) {
      for (const s of p.SENTINELS.filter((s) => s !== p.STOPPED)) expect(d).toContain(s);
      expect(d).toContain(p.TURN_NOTE);
      expect(d).toContain(p.NO_SLEEP_NOTE);
    }
  });
  it('unfinished word list', () => {
    expect([...p.UNFINISHED_END]).toEqual(fixture.unfinishedWords);
  });
  it('turn and 409 formats', () => {
    const at = (h: number, m: number, s: number) => new Date(2026, 9, 5, h, m, s).getTime();
    expect(p.turnReply(3, 'hello there', at(10, 15, 2), at(10, 15, 9))).toBe(fixture.turnExample);
    expect(p.TURN_PREFIX.exec(fixture.turnExample)?.slice(1)).toEqual(['3', '10:15:02', '10:15:09']);
    expect(p.unansweredError(4)).toBe(fixture.unanswered409);
  });
});

describe('readsUnfinished', () => {
  it.each([
    ['so I was thinking', true],
    ['I went to the', true],
    ["and it's", true],
    ['That is all.', false],
    ['', false],
    ['   ', false],
    ['AND', true],
  ])('%j -> %s', (t, want) => expect(p.readsUnfinished(t)).toBe(want));
});

describe('read notes', () => {
  it('formats', () => {
    expect(p.readNotes.stopped(2, 5, 'the same file')).toBe(
      'He stopped it during part 2 of 5. To resume there, call tts with the same file and part=2.',
    );
    expect(p.readNotes.stopped(1, 1, 'the same text')).toBe('He stopped it.');
    expect(p.readNotes.outOfTime(1, 3, 9, 'the same url')).toBe(
      'Read parts 1 to 3 of 9. To go on, call tts again with the same url and part=4.',
    );
    expect(p.readNotes.end(4)).toBe('Read to the end (part 4 of 4).');
  });
});

describe('RequestBody', () => {
  it('round trips a tts body', () => {
    const b = { kind: 'tts', text: 'hi', listen: true, rate: 1.3, volume: 0.5, idleSec: 200, who: 'session' } as const;
    expect(p.RequestBody.parse(JSON.parse(JSON.stringify(b)))).toEqual(b);
  });
  it('defaults who to session', () => {
    expect(p.RequestBody.parse({ kind: 'stt', ack: 3 }).who).toBe('session');
  });
  it.each([
    [{ kind: 'tts' }],
    [{ kind: 'tts', text: 'a', file: 'b' }],
    [{ kind: 'tts', text: 'a', url: 'u', file: 'f' }],
    [{ kind: 'stt', idleSec: 201 }],
    [{ kind: 'stt', idleSec: -1 }],
    [{ kind: 'tts', text: 'a', rate: 0.4 }],
    [{ kind: 'tts', text: 'a', rate: 2.1 }],
    [{ kind: 'tts', text: 'a', volume: 1.1 }],
    [{ kind: 'tts', text: 'a', part: 0 }],
    [{ kind: 'stt', who: 'helper' }],
    [{ kind: 'speak' }],
    ['not an object'],
  ])('rejects %j', (b) => expect(p.RequestBody.safeParse(b).success).toBe(false));
  it('accepts file or url alone and range edges', () => {
    for (const b of [
      { kind: 'tts', file: 'C:\\Users\\Mark\\notes.md' },
      { kind: 'tts', url: 'https://x.test/a.md' },
      { kind: 'tts', text: '', rate: 0.5, volume: 0, idleSec: 0 },
      { kind: 'tts', text: 'a', rate: 2, volume: 1, idleSec: 200 },
    ])
      expect(p.RequestBody.safeParse(b).success).toBe(true);
  });
});

describe('WebSocket messages', () => {
  const page: p.PageMessage[] = [
    { type: 'ready' },
    { type: 'complete', text: 'hello', startAt: 1, endAt: 2 },
    { type: 'cancel' },
    { type: 'close' },
    { type: 'ended' },
    { type: 'nospeech' },
    { type: 'stopped', part: 2 },
    { type: 'log', line: 'mic start' },
    { type: 'settings', settings: { rate: 1.3 } },
  ];
  it.each(page)('page %j round trips', (m) => {
    expect(p.parseMessage(p.PageMessage, JSON.stringify(m))).toEqual(m);
  });
  const daemon: p.DaemonMessage[] = [
    { type: 'request', id: 7, body: { kind: 'stt', who: 'session' } },
    { type: 'released', reason: 'superseded' },
    { type: 'released', reason: 'timeout' },
  ];
  it.each(daemon)('daemon %j round trips', (m) => {
    expect(p.parseMessage(p.DaemonMessage, JSON.stringify(m))).toEqual(m);
  });
  it.each([
    '',
    'not json',
    '{"type":"nope"}',
    '{"type":"complete","text":"x"}',
    '{"type":"stopped","part":0}',
    'null',
    '[]',
  ])('bad frame %j is undefined, never throws', (raw) => {
    expect(p.parseMessage(p.PageMessage, raw)).toBeUndefined();
  });
  it('released without a reason is bad', () => {
    expect(p.parseMessage(p.DaemonMessage, '{"type":"released"}')).toBeUndefined();
  });
});
