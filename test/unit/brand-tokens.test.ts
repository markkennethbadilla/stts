import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// Register B20: colours live only in web/index.css; vendored shadcn components under web/components/ui are exempt.
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? e.name === 'ui'
        ? []
        : files(join(dir, e.name))
      : e.name.endsWith('.tsx')
        ? [join(dir, e.name)]
        : [],
  );

test('no raw colour or palette class outside the token file', () => {
  const hits = files('web').flatMap((f) =>
    [
      ...readFileSync(f, 'utf8').matchAll(
        /#[0-9a-fA-F]{3,8}\b|\b(?:bg|text|border|fill|stroke)-(?:red|blue|green|amber|yellow|neutral|gray|zinc|slate)-\d+/g,
      ),
    ].map((m) => `${f}: ${m[0]}`),
  );
  expect(hits).toEqual([]);
});

test('every turn hue the page reads is a token', () => {
  const css = readFileSync('web/index.css', 'utf8');
  for (const k of ['not-listening', 'speak-now', 'working', 'heard', 'background', 'agent-speaking'])
    for (const n of [1, 2]) expect(css).toMatch(new RegExp(`--state-${k}-${n}: #[0-9a-f]{6};`));
  expect(css).toMatch(/--state-mic-error: #/);
});
