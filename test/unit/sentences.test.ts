import { describe, expect, it } from 'vitest';
import { FIRST_CHARS, PART_CHARS, toClips, toParts } from '../../src/sentences.ts';

const squash = (s: string) => s.replace(/\s+/g, '');

describe('toParts', () => {
  it('empty and blank input give no parts', () => {
    expect(toParts('')).toEqual([]);
    expect(toParts(' \r\n\t ')).toEqual([]);
  });
  it('short text is one part', () => {
    expect(toParts('One. Two? Three!')).toEqual(['One. Two? Three!']);
  });
  it('no sentence end is still cut at a space under the limit', () => {
    const t = 'word '.repeat(700);
    const parts = toParts(t);
    expect(parts.length).toBeGreaterThan(1);
    for (const x of parts) expect(x.length).toBeLessThanOrEqual(PART_CHARS);
    expect(parts.join(' ')).toBe(t.trim());
  });
  it('a token with no spaces is hard-cut', () => {
    const t = 'x'.repeat(2500);
    expect(toParts(t).map((x) => x.length)).toEqual([1000, 1000, 500]);
  });
  it('1000-character boundary', () => {
    const exact = `${'a'.repeat(998)}.`;
    expect(toParts(exact)).toEqual([exact]);
    const two = `${'a'.repeat(499)}. ${'b'.repeat(499)}.`; // 1001 chars
    expect(toParts(two)).toEqual([`${'a'.repeat(499)}.`, `${'b'.repeat(499)}.`]);
    const fits = `${'a'.repeat(498)}. ${'b'.repeat(499)}.`; // 1000 chars
    expect(toParts(fits)).toEqual([fits]);
  });
  it('keeps Windows paths and URLs whole', () => {
    const t = 'Open C:\\Users\\Mark\\notes.v2.md now. Then see https://x.test/a?b=1.';
    expect(toParts(t)).toEqual([t]);
  });
  it('normalises CRLF', () => {
    expect(toParts('a.\r\nb.\rc.')).toEqual(['a.\nb.\nc.']);
  });
  it('5 MB loses nothing and stays within the limit', () => {
    const t = 'The quick brown fox jumps over the lazy dog. '.repeat(Math.ceil((5 * 1024 * 1024) / 45));
    const parts = toParts(t);
    for (const x of parts) expect(x.length).toBeLessThanOrEqual(PART_CHARS);
    expect(squash(parts.join(''))).toBe(squash(t));
  });
});

// The first clip is short so Piper renders it at once (Mark 2026-10-10: "could it be instantaneous?").
describe('toClips', () => {
  const joined = (c: string[]) => squash(c.join(''));
  it('empty input gives no clips', () => {
    expect(toClips('', 120)).toEqual([]);
    expect(toClips(' \n ', 120)).toEqual([]);
  });
  it('a short first sentence is clip one alone, never packed with the next', () => {
    const t = 'Good point. A helper is updating the rules now. It will be done soon.';
    expect(toClips(t, 120)).toEqual(['Good point.', 'A helper is updating the rules now. It will be done soon.']);
  });
  it('a long first sentence is cut after its first clause', () => {
    const t = 'Okay, I am on it, and a helper is reading the daemon log now to time every stage.';
    const c = toClips(t, 120);
    // Not "Okay,": a clause under 8 characters is too short a clip to cover the next one's synthesis.
    expect(c[0]).toBe('Okay, I am on it,');
    expect(joined(c)).toBe(squash(t));
  });
  it('no clause: cut after the last whole word under the limit, then clips in order', () => {
    const t = `Both Windows accounts now join the work tailnet at sign in and the check runs first. ${'More words here. '.repeat(20)}`;
    const c = toClips(t, 120);
    expect(c[0]).toBe('Both Windows accounts now join the work');
    expect(c[0]?.length).toBeLessThanOrEqual(FIRST_CHARS);
    for (const x of c.slice(1)) expect(x.length).toBeLessThanOrEqual(120);
    expect(joined(c)).toBe(squash(t));
  });
  it('a token with no spaces is hard-cut at the limit', () => {
    expect(toClips('x'.repeat(300), 120).map((x) => x.length)).toEqual([
      FIRST_CHARS,
      120,
      120,
      300 - FIRST_CHARS - 240,
    ]);
  });
  it('CRLF and a Windows path lose nothing', () => {
    const t = 'Open C:\\Users\\Mark\\AppData\\Local\\cc-gc-stts\\daemon.log and read the tail.\r\nThen stop.';
    expect(joined(toClips(t, 120))).toBe(squash(t));
  });
  it('5 MB keeps every character and the limits', () => {
    const t = 'The quick brown fox jumps over the lazy dog. '.repeat(Math.ceil((5 * 1024 * 1024) / 45));
    const c = toClips(t, 120);
    expect(c[0]).toBe('The quick brown fox jumps over the lazy');
    for (const x of c.slice(1)) expect(x.length).toBeLessThanOrEqual(120);
    expect(joined(c)).toBe(squash(t));
  });
});
