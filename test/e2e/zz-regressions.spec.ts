// Regressions fixed on 2026-10-06; each test guards one behaviour Mark saw come back.
// Named zz- so it runs after voice.spec.ts: its last test presses End, which stops the daemon.
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { APIRequestContext, Page } from '@playwright/test';
import { testPort } from '../../playwright.config.ts';
import { CONVERSATION_ENDED } from '../../src/protocol.ts';
import { daemonLog, expect, test } from './fixtures.ts';

const ask = (request: APIRequestContext, data: object) =>
  request.post('/request', { data: { who: 'session', ...data }, timeout: 60_000 });
const say = (voice: Page, t: string) =>
  voice.evaluate((x) => (globalThis as unknown as { __say: (s: string) => void }).__say(x), t);

function wav(): Buffer {
  const data = 8000 * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(data, 40);
  return b;
}

// A turn left unanswered by an earlier test makes a bare stt a 409: answer it with a short tts
// (a fake Piper replies at once), then listen.
async function listen(request: APIRequestContext) {
  const piper = createServer((req, res) => {
    req.resume();
    req.on('end', () => res.writeHead(200, { 'content-type': 'audio/wav' }).end(wav()));
  });
  piper.listen(testPort + 1, '127.0.0.1');
  await once(piper, 'listening');
  try {
    await ask(request, { kind: 'tts', text: 'Okay.' });
  } finally {
    piper.close();
  }
  return ask(request, { kind: 'stt' });
}

test('at a narrow width the Send button sits under the box, and the box keeps the row', async ({ voice }) => {
  await voice.setViewportSize({ width: 300, height: 700 });
  await voice.getByLabel('Switch to keyboard input').focus();
  await voice.keyboard.press('Enter');
  const box = await voice.getByLabel('Message').boundingBox();
  const send = await voice.getByLabel('Send').boundingBox();
  expect(box && send && send.y >= box.y + box.height - 1).toBe(true);
  expect(box?.width ?? 0).toBeGreaterThan(240);
});

test('Dark Reader is locked out and the theme setting applies', async ({ voice }) => {
  await expect(voice.locator('meta[name="darkreader-lock"]')).toHaveCount(1);
  for (const [theme, dark] of [
    ['light', false],
    ['dark', true],
  ] as const) {
    await voice.evaluate((t) => localStorage.setItem('__stts__theme', t), theme);
    await voice.reload();
    expect(await voice.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(dark);
  }
});

test('an automatic mic restart plays no chime', async ({ voice, request }) => {
  const chimes: string[] = [];
  voice.on('request', (r) => {
    if (r.url().includes('/earcon/listen-open')) chimes.push(r.url());
  });
  // The fixture turns earcons off in an init script; a later one turns them back on.
  await voice.addInitScript(() => localStorage.setItem('__stts__earcons', '1'));
  await voice.reload();
  const reply = listen(request);
  await expect(voice.getByLabel('speakNow')).toBeVisible();
  await expect.poll(() => chimes.length).toBe(1);
  // The recogniser fails: the page restarts it on its own, silently.
  await voice.evaluate(() =>
    (globalThis as unknown as { __rec: { onerror: (e: unknown) => void } }).__rec.onerror({ error: 'network' }),
  );
  await voice.clock.fastForward(3000);
  await expect.poll(daemonLog).toMatch(/mic restart #\d+: mic error/);
  await expect(voice.getByLabel('speakNow')).toBeVisible();
  expect(chimes.length).toBe(1);
  await say(voice, 'done here now');
  await voice.clock.fastForward(1500);
  expect(await (await reply).text()).toMatch(/done here now$/);
});

test('a fragment of the long sentence being spoken is echo, not a barge', async ({ voice, request }) => {
  const held: (() => void)[] = [];
  const piper = createServer((req, res) => {
    req.resume();
    req.on('end', () => held.push(() => res.writeHead(200, { 'content-type': 'audio/wav' }).end(wav())));
  });
  piper.listen(testPort + 1, '127.0.0.1');
  await once(piper, 'listening');
  try {
    const speech = ask(request, {
      kind: 'tts',
      text: 'Our conversation would carry on, and the listen you have open stays open while it reloads.',
    });
    await expect(voice.getByLabel('agentSpeaking')).toBeVisible();
    await expect.poll(() => voice.evaluate(() => '__rec' in globalThis)).toBe(true);
    await say(voice, 'our conversations carry on');
    await expect.poll(daemonLog).toContain('page echo discarded');
    await expect(voice.getByLabel('agentSpeaking')).toBeVisible();
    for (const send of held.splice(0)) send();
    await voice.getByLabel(/Skip/).click();
    expect(await (await speech).text()).not.toMatch(/\[turn/);
  } finally {
    for (const send of held.splice(0)) send();
    piper.close();
  }
});

// Last: End stops the daemon.
test('End is final: the open listen and the next call both return ENDED', async ({ voice, request }) => {
  const reply = listen(request);
  await expect(voice.getByLabel('speakNow')).toBeVisible();
  await voice.getByLabel('End conversation').click();
  expect(await (await reply).text()).toBe(CONVERSATION_ENDED);
  expect(await (await ask(request, { kind: 'stt' })).text()).toBe(CONVERSATION_ENDED);
});
