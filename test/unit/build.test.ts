// npm run build puts every artifact where dist/daemon.js serves it from.
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';

it('builds dist/mcp.js, dist/daemon.js, dist/web/ and dist/earcon/', { timeout: 120_000 }, () => {
  execSync('npm run build', { stdio: 'ignore' });
  for (const p of ['mcp.js', 'daemon.js', 'web/index.html', 'earcon/listen-open.ogg']) {
    expect(existsSync(`dist/${p}`), p).toBe(true);
  }
});
