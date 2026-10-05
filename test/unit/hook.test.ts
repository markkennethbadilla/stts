import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { expect, test } from 'vitest';

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => resolve(typeof a === 'object' && a ? a.port : 0));
    });
  });

test('hook exits 0 fast with the daemon down', async () => {
  const port = await freePort();
  const t = Date.now();
  const r = spawnSync('node', ['hooks/notify-listen.mjs'], { env: { ...process.env, STTS_PORT: String(port) } });
  expect(r.status).toBe(0);
  expect(Date.now() - t).toBeLessThan(4000);
});

test('plugin manifest has the fields Claude Code needs and no version', () => {
  const p = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8'));
  expect(p.name).toBe('stts');
  expect(p.version).toBeUndefined();
  const m = JSON.parse(readFileSync('.claude-plugin/marketplace.json', 'utf8'));
  expect(m.name).toBe('stts-marketplace');
  expect(m.plugins[0].source).toEqual({ source: 'github', repo: 'markkennethbadilla/stts' });
  const h = JSON.parse(readFileSync('hooks/hooks.json', 'utf8'));
  expect(h.hooks.SubagentStop[0].hooks[0].command).toContain('notify-listen.mjs');
});

test('/stts command text carries every sentinel', () => {
  for (const f of ['commands/stts.md', 'commands/stts.toml', 'skills/stts/SKILL.md']) {
    const t = readFileSync(f, 'utf8');
    for (const s of ['__STTS_CONVERSATION_ENDED__', '__STTS_NO_SPEECH__', '__STTS_LISTEN_CONTINUES__', '[turn N,'])
      expect(t, `${f} ${s}`).toContain(s);
  }
});
