// npm run build puts every artifact where dist/daemon.js serves it from.
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';

it('builds dist/mcp.js, dist/daemon.js, dist/web/ and dist/earcon/', { timeout: 120_000 }, () => {
  // Vitest sets NODE_ENV=test, which would make Vite emit a dev React build into the committed dist/.
  execSync('npm run build', { stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production' } });
  for (const p of ['mcp.js', 'daemon.js', 'web/index.html', 'earcon/listen-open.ogg']) {
    expect(existsSync(`dist/${p}`), p).toBe(true);
  }
});
