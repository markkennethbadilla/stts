// Read-aloud parts: sentence boundaries from Intl.Segmenter, packed into parts of at
// most PART_CHARS (about a minute of speech). A sentence longer than that is cut at a
// space, or hard-cut when it has none. The callbot imports this file.
export const PART_CHARS = 1000;

const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

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
      const space = s.lastIndexOf(' ', max);
      const cut = space > 0 ? space : max;
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

/** Speech clips: the first sentence alone, or its first clause or words when longer than FIRST_CHARS. */
export function toClips(text: string, max: number): string[] {
  const t = text.replace(/\r\n?/g, '\n').trim();
  let one = segmenter.segment(t).containing(0)?.segment.trimEnd() ?? '';
  if (!one) return [];
  // A longer first sentence: cut after its first clause (a comma, semicolon, colon or dash), else
  // after the last whole word that fits, else hard at FIRST_CHARS.
  if (one.length > FIRST_CHARS) {
    const head = one.slice(0, FIRST_CHARS + 1);
    const space = head.lastIndexOf(' ');
    one = /^.{8,}?[,;:–—](?=\s)/.exec(head)?.[0] ?? (space > 0 ? head.slice(0, space) : head.slice(0, FIRST_CHARS));
  }
  return [one, ...toParts(t.slice(one.length), max)];
}
