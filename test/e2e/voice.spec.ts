import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { dataRoot, testPort } from '../../playwright.config.ts';
import { BACKGROUND_RESULT, readNotes, STOPPED, SUPERSEDED } from '../../src/protocol.ts';
import { daemonLog, expect, test } from './fixtures.ts';

const ask = (request: APIRequestContext, data: object) =>
  request.post('/request', { data: { who: 'session', ...data }, timeout: 60_000 });

test('a listen produces a turn', async ({ voice, request }) => {
  const reply = ask(request, { kind: 'stt' });
  await expect(voice.getByLabel('speakNow')).toBeVisible();
  await voice.evaluate(() => (globalThis as unknown as { __say: (t: string) => void }).__say('hello there world'));
  await voice.clock.fastForward(1500);
  const text = await (await reply).text();
  expect(text).toContain('hello there world');
  const n = /\[turn (\d+), heard/.exec(text)?.[1];
  expect(n).toBeDefined();
  // Answer the turn so later listens are not refused, then end that listen.
  const next = ask(request, { kind: 'stt', ack: Number(n) });
  await expect(voice.getByLabel('speakNow')).toBeVisible();
  await request.post('/notify');
  expect(await (await next).text()).toBe(BACKGROUND_RESULT);
});

test('pause survives 3 listens and the watchdog', async ({ voice, request }) => {
  await voice.keyboard.press('Control+m');
  await expect(voice).toHaveTitle('stts (muted)');
  const p1 = ask(request, { kind: 'stt' });
  await voice.waitForTimeout(300);
  const p2 = ask(request, { kind: 'stt' });
  expect(await (await p1).text()).toBe(SUPERSEDED);
  const p3 = ask(request, { kind: 'stt' });
  expect(await (await p2).text()).toBe(SUPERSEDED);
  // fastForward, not runFor: runFor would render every orb frame on the way.
  for (let i = 0; i < 10; i++) await voice.clock.fastForward(2000);
  await expect(voice).toHaveTitle('stts (muted)');
  await request.post('/notify');
  expect(await (await p3).text()).toBe(BACKGROUND_RESULT);
  const log = daemonLog();
  const after = log.slice(log.lastIndexOf('page paused by Mark'));
  expect(after).toContain('paused by Mark');
  expect(after).not.toContain('mic start');
});

test('an untrusted End click is ignored', async ({ voice, request }) => {
  await voice.evaluate(() => document.querySelector<HTMLElement>('[aria-label="End conversation"]')?.click());
  await voice.waitForTimeout(300);
  expect(await (await request.get('/api/ping')).text()).toBe('ok');
  expect(await (await request.get('/barge')).json()).toEqual({ text: '', open: true });
});

test('/notify produces a background result', async ({ voice, request }) => {
  const reply = ask(request, { kind: 'stt' });
  await expect(voice.getByLabel('speakNow')).toBeVisible();
  await request.post('/notify');
  expect(await (await reply).text()).toBe(BACKGROUND_RESULT);
  await expect(voice.getByLabel('background')).toBeVisible();
});

// One second of 8 kHz 16-bit mono silence.
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

test('a file is read in parts and resumed', async ({ voice, request }) => {
  let clips = 0;
  // Hold every clip after the first until Stop is pressed, so a fast runner cannot finish part 1 first.
  const held: (() => void)[] = [];
  let hold = true;
  const piper = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      clips++;
      const send = () => res.writeHead(200, { 'content-type': 'audio/wav' }).end(wav());
      if (hold && clips > 1) held.push(send);
      else send();
    });
  });
  piper.listen(testPort + 1, '127.0.0.1');
  await once(piper, 'listening');
  try {
    mkdirSync(dataRoot, { recursive: true });
    const file = join(dataRoot, 'read.txt');
    writeFileSync(file, 'This is a sentence that the voice reads out loud for the test. '.repeat(40));
    const first = ask(request, { kind: 'tts', file });
    await expect(voice.getByLabel('agentSpeaking')).toBeVisible();
    await expect.poll(() => clips).toBeGreaterThan(0);
    // Focus and Enter: a trusted click with no actionability wait on animation frames, which page.clock holds.
    await voice.getByLabel('Stop').focus();
    await voice.keyboard.press('Enter');
    hold = false;
    for (const send of held.splice(0)) send();
    const stopped = await (await first).text();
    expect(stopped).toMatch(new RegExp(`^${STOPPED} 1 `));
    const n = Number(/of (\d+)/.exec(stopped)?.[1]);
    expect(n).toBeGreaterThan(1);
    const rest = await ask(request, { kind: 'tts', file, part: 2 });
    expect(await rest.text()).toBe(readNotes.end(n));
    expect(clips).toBeGreaterThanOrEqual(n);
  } finally {
    piper.close();
  }
});
