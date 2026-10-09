import { spawn, spawnSync } from 'node:child_process';
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

// Payload shapes as Claude Code sends them (fields seen in session cec2b5e7, 2026-10-09).
const stop = (agentType: string, transcript: string) =>
  JSON.stringify({
    hook_event_name: 'SubagentStop',
    stop_hook_active: false,
    agent_id: 'a162a3df8c5047cf1',
    agent_type: agentType,
    agent_transcript_path: transcript,
    background_tasks: [],
  });
const base = 'C:\\Users\\Work\\.claude\\projects\\p\\cec2b5e7';

test('only a stop that reaches the session as a task-notification pokes the daemon', async () => {
  let hits = 0;
  const { createServer: http } = await import('node:http');
  const srv = http((_q, r) => {
    hits++;
    r.end('ok');
  });
  const port = await new Promise<number>((res) =>
    srv.listen(0, '127.0.0.1', () => res((srv.address() as { port: number }).port)),
  );
  const run = (input: string) =>
    new Promise<number | null>((res) => {
      const c = spawn('node', ['hooks/notify-listen.mjs'], { env: { ...process.env, STTS_PORT: String(port) } });
      c.on('exit', res);
      c.stdin.end(input);
    });
  expect(
    await run(
      stop('workflow-subagent', `${base}\\subagents\\workflows\\wf_cdbc527a-8b3\\agent-a162a3df8c5047cf1.jsonl`),
    ),
  ).toBe(0);
  expect(await run(stop('', `${base}/subagents/workflows/wf_x/agent-b.jsonl`))).toBe(0);
  expect(hits).toBe(0);
  expect(await run(stop('general-purpose', `${base}\\subagents\\agent-a14c0eff6821e6e1f.jsonl`))).toBe(0);
  expect(hits).toBe(1);
  expect(await run('not json')).toBe(0);
  expect(hits).toBe(2);
  srv.close();
});

test('plugin manifest has the fields Claude Code needs and no version', () => {
  const p = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8'));
  expect(p.name).toBe('stts');
  expect(p.version).toBeUndefined();
  const m = JSON.parse(readFileSync('.claude-plugin/marketplace.json', 'utf8'));
  expect(m.name).toBe('stts-marketplace');
  expect(m.plugins[0].source).toBe('./');
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
