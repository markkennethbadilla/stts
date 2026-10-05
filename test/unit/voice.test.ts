// GET /voice/list reads the Piper voices folder; a refused clip and a page fallback are logged.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createActor } from 'xstate';

const home = mkdtempSync(join(tmpdir(), 'stts-piper-'));
mkdirSync(join(home, 'voices'));
for (const f of ['en_US-amy-medium.onnx', 'en_GB-jenny_dioco-medium.onnx', 'en_GB-jenny_dioco-medium.onnx.json'])
  writeFileSync(join(home, 'voices', f), '');
process.env['STTS_PIPER_HOME'] = home;
const { app, attachPage, deps } = await import('../../src/daemon.ts');
const { pageMachine } = await import('../../web/machine');
const logged: string[] = [];
deps.log = (l) => void logged.push(l);

it('/voice/list names the installed Piper voices, sorted, no .json', async () => {
  expect(await (await app.request('/voice/list')).json()).toEqual(['en_GB-jenny_dioco-medium', 'en_US-amy-medium']);
});

it('/voice/clip refuses a Windows voice name and logs it', async () => {
  const r = await app.request('/voice/clip', {
    method: 'POST',
    body: JSON.stringify({ text: 'hi', voice: 'Microsoft Zira Desktop' }),
  });
  expect(r.status).toBe(400);
  expect(logged).toContain('piper clip refused: bad body or voice name');
});

it('a failed clip logs page voice fallback <reason> before the browser voice speaks', () => {
  logged.length = 0;
  const link = attachPage(() => {});
  const order: string[] = [];
  const actor = createActor(
    pageMachine.provide({
      actions: {
        log: (_, { line }) => link.onMessage(JSON.stringify({ type: 'log', line })),
        speakFallback: () => void order.push(logged.at(-1) ?? ''),
      },
    }),
  ).start();
  actor.send({ type: 'ENQUEUE', clips: ['a'] });
  actor.send({ type: 'CLIP_FAILED', reason: 'clip 502 en_GB-jenny_dioco-medium' });
  expect(order).toEqual(['page voice fallback clip 502 en_GB-jenny_dioco-medium']);
  link.detach();
});
