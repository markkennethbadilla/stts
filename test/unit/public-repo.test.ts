// Public repo rules (spec 009): code runs on a stranger's machine, binds only 127.0.0.1, and pins exact versions.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === 'components') return [];
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|mjs|js)$/.test(n) ? [p] : [];
  });
const COMMENT = /^\s*(\/\/|\/?\*)/;

it('no code line in src, web or scripts needs our drive, ops repos or account folders', () => {
  const bad = ['src', 'web', 'scripts'].flatMap(files).flatMap((f) =>
    readFileSync(f, 'utf8')
      .split(/\r?\n/)
      .filter((l) => !COMMENT.test(l) && /[A-Z]:[\\/]|mkb-(agentops|winops|vpsops)|personal-markkennethbadilla/.test(l))
      .map((l) => `${f}: ${l.trim()}`),
  );
  expect(bad).toEqual([]);
});

it('the daemon and Piper bind 127.0.0.1 only', () => {
  const d = readFileSync('src/daemon.ts', 'utf8');
  expect(d).toContain("hostname: '127.0.0.1'");
  expect(d).toContain("'--host', '127.0.0.1'");
  expect(d).not.toMatch(/hostname: '0\.0\.0\.0'|'--host', '0\.0\.0\.0'/);
});

it('every dependency is pinned to an exact version', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const loose = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(
    ([, v]) => !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(String(v)),
  );
  expect(loose).toEqual([]);
});
