import { describe, expect, it } from 'vitest';
import { PART_CHARS, toParts } from '../../src/sentences.ts';

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
