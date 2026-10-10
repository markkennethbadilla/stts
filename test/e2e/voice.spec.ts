import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { dataRoot, testPort } from '../../playwright.config.ts';
import { BACKGROUND_RESULT, bargeLine, readNotes, STOPPED, SUPERSEDED } from '../../src/protocol.ts';
import { daemonLog, expect, test } from './fixtures.ts';

const ask = (request: APIRequestContext, data: object) =>
  request.post('/request', { data: { who: 'session', ...data }, timeout: 150_000 });

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
  // Sentence-sized clips (spec 006) play one by one: three parts of real-time clips need over a minute.
  test.setTimeout(180_000);
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
    // Distinct sentences: clips are cached by text, so a repeated sentence made one request, the hold
    // never engaged, and a slow runner read all three parts before Stop landed (CI, 2026-10-07).
    writeFileSync(
      file,
      Array.from({ length: 40 }, (_, i) => `This is sentence number ${i} that the voice reads out loud.`).join(' '),
    );
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

// The message box is always shown (Mark 2026-10-10).
const keyboardMode = async (voice: import('@playwright/test').Page) => {
  await expect(voice.getByLabel('Message')).toBeVisible();
};

test('a typed message is returned by stt as a turn', async ({ voice, request }) => {
  await keyboardMode(voice);
  const reply = ask(request, { kind: 'stt' });
  await expect(voice.getByLabel('speakNow')).toBeVisible();
  await voice.getByLabel('Message').fill('typed from the keyboard');
  await voice.getByLabel('Message').press('Enter');
  const text = await (await reply).text();
  expect(text).toMatch(/^\[turn \d+, typed [\d:]+ to [\d:]+\] typed from the keyboard$/);
  await expect(voice.getByLabel('Message')).toHaveValue('');
  expect(daemonLog()).toMatch(/page typed turn \d+/);
});

test('typing during speech cuts it off and the tts returns the turn with the barge note', async ({
  voice,
  request,
}) => {
  // Hold every clip so the speech is still playing when the message is sent.
  const held: (() => void)[] = [];
  const piper = createServer((req, res) => {
    req.resume();
    req.on('end', () => held.push(() => res.writeHead(200, { 'content-type': 'audio/wav' }).end(wav())));
  });
  piper.listen(testPort + 1, '127.0.0.1');
  await once(piper, 'listening');
  try {
    await keyboardMode(voice);
    const speech = ask(request, { kind: 'tts', text: 'One sentence here. Another sentence there. A third one.' });
    await expect(voice.getByLabel('agentSpeaking')).toBeVisible();
    await voice.getByLabel('Message').fill('also check the logs');
    // The page re-renders the box after the fill; Enter before that sent an empty box (busy machine, 2026-10-10).
    await expect(voice.getByLabel('Message')).toHaveValue('also check the logs');
    await voice.getByLabel('Message').press('Enter');
    const text = await (await speech).text();
    expect(text).toMatch(/^\[turn \d+, typed [\d:]+ to [\d:]+\] also check the logs\n/);
    expect(text).toContain(bargeLine(1, 1));
  } finally {
    for (const send of held.splice(0)) send();
    piper.close();
  }
});

test('speaking over the agent cuts it off; its own echo and short words do not', async ({ voice, request }) => {
  // Hold every clip so the speech is still playing when the words arrive.
  const held: (() => void)[] = [];
  const piper = createServer((req, res) => {
    req.resume();
    req.on('end', () => held.push(() => res.writeHead(200, { 'content-type': 'audio/wav' }).end(wav())));
  });
  piper.listen(testPort + 1, '127.0.0.1');
  await once(piper, 'listening');
  try {
    const speech = ask(request, { kind: 'tts', text: 'One sentence here. Another sentence there. A third one.' });
    await expect(voice.getByLabel('agentSpeaking')).toBeVisible();
    await expect.poll(() => voice.evaluate(() => '__rec' in globalThis)).toBe(true);
    const say = (t: string) =>
      voice.evaluate((x) => (globalThis as unknown as { __say: (s: string) => void }).__say(x), t);
    await say('one sentence here');
    await say('wait');
    await expect.poll(daemonLog).toContain('page echo discarded');
    await expect(voice.getByLabel('agentSpeaking')).toBeVisible();
    await say('use the other repo please');
    const text = await (await speech).text();
    expect(text).toMatch(/^\[turn \d+, heard [\d:]+ to [\d:]+\] use the other repo please\n/);
    expect(text).toContain(bargeLine(1, 1));
  } finally {
    for (const send of held.splice(0)) send();
    piper.close();
  }
});

test('Repeat replays the last reply from the page alone; Stop over it leaves the listen open', async ({
  voice,
  request,
}) => {
  test.setTimeout(120_000);
  let clips = 0;
  let hold = false;
  const held: (() => void)[] = [];
  const piper = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      clips++;
      const send = () => res.writeHead(200, { 'content-type': 'audio/wav' }).end(wav());
      if (hold) held.push(send);
      else send();
    });
  });
  piper.listen(testPort + 1, '127.0.0.1');
  await once(piper, 'listening');
  const press = async (label: string) => {
    await voice.getByLabel(label).focus();
    await voice.keyboard.press('Enter');
  };
  try {
    // Nothing spoken yet: nothing to repeat.
    await expect(voice.getByLabel('Repeat last reply')).toBeDisabled();
    const long = Array.from({ length: 12 }, (_, i) => `Sentence ${i} of the long reply is read again.`).join(' ');
    await (await ask(request, { kind: 'tts', text: long })).text();
    const spoken = clips;
    expect(spoken).toBeGreaterThan(1);
    // A listen is open; Repeat plays every clip again and the listen stays open.
    const reply = ask(request, { kind: 'stt' });
    await expect(voice.getByLabel('speakNow')).toBeVisible();
    await press('Repeat last reply');
    await expect(voice.getByLabel('agentSpeaking')).toBeVisible();
    await expect(voice.getByLabel('Repeat last reply')).toBeDisabled();
    await expect(voice.getByLabel('speakNow')).toBeVisible({ timeout: 60_000 });
    expect(clips).toBeGreaterThanOrEqual(spoken * 2);
    expect(daemonLog()).toContain('page repeat by Mark');
    // Stop during a repeat silences it only: the same listen still returns his words, with no barge line.
    hold = true;
    await press('Repeat last reply');
    await expect(voice.getByLabel('agentSpeaking')).toBeVisible();
    await press('Stop');
    await expect(voice.getByLabel('speakNow')).toBeVisible();
    await voice.evaluate(() => (globalThis as unknown as { __say: (t: string) => void }).__say('after the repeat'));
    await voice.clock.fastForward(1500);
    const text = await (await reply).text();
    expect(text).toMatch(/^\[turn \d+, heard [\d:]+ to [\d:]+\] after the repeat$/);
    expect(text).not.toContain(STOPPED);
    // A new reply arriving during a repeat cuts it short and still returns as spoken.
    for (const send of held.splice(0)) send();
    hold = false;
    await press('Repeat last reply');
    await expect(voice.getByLabel('agentSpeaking')).toBeVisible();
    expect(await (await ask(request, { kind: 'tts', text: 'A brand new reply.' })).text()).toBe(readNotes.spoken);
  } finally {
    for (const send of held.splice(0)) send();
    piper.close();
  }
});
