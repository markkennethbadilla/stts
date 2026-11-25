import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChromeRecognition } from '../../web/chromeRecognition.ts';

// Chrome ends a session on its own; the wrapper restarts at once and keeps the words (spec 014).
const made: Fake[] = [];
class Fake {
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error?: string }) => void) | null = null;
  onresult: ((e: { resultIndex: number; results: unknown[] }) => void) | null = null;
  started = 0;
  constructor() {
    made.push(this);
  }
  start() {
    this.started++;
    this.onstart?.();
  }
  stop() {
    this.onend?.();
  }
  abort() {
    this.onend?.();
  }
  say(list: [string, boolean][], resultIndex = 0) {
    this.onresult?.({
      resultIndex,
      results: list.map(([t, f]) => Object.assign([{ transcript: t }], { isFinal: f })),
    });
  }
}

beforeEach(() => {
  made.length = 0;
  vi.useFakeTimers();
  (globalThis as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition = Fake;
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
});

describe('ChromeRecognition', () => {
  it('restarts when Chrome ends a session and keeps the words that were still forming', () => {
    const r = new ChromeRecognition();
    const starts = vi.fn();
    const ends = vi.fn();
    const seen: { resultIndex: number; texts: string[]; finals: boolean[] }[] = [];
    r.onstart = starts;
    r.onend = ends;
    r.onresult = (e) =>
      seen.push({
        resultIndex: e.resultIndex,
        texts: Array.from(e.results, (x) => x[0]?.transcript ?? ''),
        finals: Array.from(e.results, (x) => x.isFinal),
      });
    r.start();
    made[0]?.say([['hello there', false]]);
    vi.advanceTimersByTime(1000);
    made[0]?.onend?.();
    expect(made).toHaveLength(2);
    expect(made[1]?.started).toBe(1);
    expect(starts).toHaveBeenCalledTimes(1);
    expect(ends).not.toHaveBeenCalled();
    expect(seen.at(-1)).toEqual({ resultIndex: 0, texts: ['hello there'], finals: [true] });
    made[1]?.say([['again', false]]);
    expect(seen.at(-1)).toEqual({ resultIndex: 1, texts: ['hello there', 'again'], finals: [true, false] });
  });

  it('a no-speech error restarts; a fatal one ends the recogniser', () => {
    const r = new ChromeRecognition();
    const errors: (string | undefined)[] = [];
    const ends = vi.fn();
    r.onerror = (e) => errors.push(e.error);
    r.onend = ends;
    r.start();
    vi.advanceTimersByTime(1000);
    made[0]?.onerror?.({ error: 'no-speech' });
    made[0]?.onend?.();
    expect(made).toHaveLength(2);
    expect(errors).toEqual([]);
    vi.advanceTimersByTime(1000);
    made[1]?.onerror?.({ error: 'not-allowed' });
    made[1]?.onend?.();
    expect(errors).toEqual(['not-allowed']);
    expect(ends).toHaveBeenCalledTimes(1);
    expect(made).toHaveLength(2);
  });

  it('abort ends it once and starts no new session', () => {
    const r = new ChromeRecognition();
    const ends = vi.fn();
    r.onend = ends;
    r.start();
    r.abort();
    expect(ends).toHaveBeenCalledTimes(1);
    expect(made).toHaveLength(1);
  });
});
