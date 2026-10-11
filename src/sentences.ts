// Read-aloud parts: sentence boundaries from Intl.Segmenter, packed into parts of at
// most PART_CHARS (about a minute of speech). A sentence longer than the limit is cut only
// at a clause mark (see cutAt), so speech never pauses mid-phrase. The callbot imports this file.
export const PART_CHARS = 1000;

const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
const CLAUSE = /[,;:–—](?=\s)/g;

// Where to cut a sentence longer than `max`: after the last clause mark within `max`, else after
// the first one past it, else not at all up to PART_CHARS. Each clip is its own Piper render, so a
// cut at a bare space put a pause and a falling tone mid-phrase ("a threat ... detection service",
// Mark 2026-10-12). Only past PART_CHARS: the last space, else a hard cut.
// A clause under 8 characters ("Okay,") is too short a clip to cover the next one's synthesis.
function cutAt(s: string, max: number): number {
  let after = 0;
  let before = 0;
  for (const m of s.matchAll(CLAUSE)) {
    const i = m.index + 1;
    if (i < 8) continue;
    if (i <= max) before = i;
    else {
      after = i;
      break;
    }
  }
  if (before) return before;
  if (after && after <= PART_CHARS) return after;
  if (s.length <= PART_CHARS) return s.length;
  const space = s.lastIndexOf(' ', PART_CHARS);
  return space > 0 ? space : PART_CHARS;
}

export function toParts(text: string, max = PART_CHARS): string[] {
  const parts: string[] = [];
  let cur = '';
  const flush = (): void => {
    const t = cur.trim();
    if (t) parts.push(t);
    cur = '';
  };
  for (const { segment } of segmenter.segment(text.replace(/\r\n?/g, '\n'))) {
    let s = segment;
    while (s.length > max) {
      flush();
      const cut = cutAt(s, max);
      cur = s.slice(0, cut);
      flush();
      s = s.slice(cut);
    }
    if (cur.length + s.length > max) flush();
    cur += s;
  }
  flush();
  return parts;
}

// The first spoken clip is short, so Piper renders it in about 0.1 s and he hears the first word
// at once; the rest are clips of up to `max`, synthesised while it plays (Mark 2026-10-10).
export const FIRST_CHARS = 40;

/** Speech clips: the first sentence alone, or its first clause when longer than FIRST_CHARS. */
export function toClips(text: string, max: number): string[] {
  const t = text.replace(/\r\n?/g, '\n').trim();
  let one = segmenter.segment(t).containing(0)?.segment.trimEnd() ?? '';
  if (!one) return [];
  if (one.length > FIRST_CHARS) one = one.slice(0, cutAt(one, FIRST_CHARS));
  return [one, ...toParts(t.slice(one.length), max)];
}
