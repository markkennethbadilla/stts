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

// Reload and wait until the new page has its daemon link and is idle: a request sent while the
// old page was closing went to it and was lost, which made these tests flaky.
async function reload(voice: Page) {
  await voice.reload();
  await expect
    .poll(async () => (await (await voice.request.get('/barge')).json()) as unknown)
    .toEqual({ text: '', open: true });
  await expect(voice.getByLabel('notListening')).toBeVisible();
  await voice.waitForTimeout(300);
}

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
  const box = await voice.getByLabel('Message').boundingBox();
  const send = await voice.getByLabel('Send').boundingBox();
  expect(box && send && send.y >= box.y + box.height - 1).toBe(true);
  expect(box?.width ?? 0).toBeGreaterThan(240);
});

test('leading words survive: interim then final, and two finals, all reach the turn', async ({ voice, request }) => {
  // Chrome's shape: one session, results grow; early words go final while later ones are interim.
  const emit = (results: [string, boolean][], from: number) =>
    voice.evaluate(
      ({ results, from }) => {
        const r = (globalThis as unknown as { __rec: { onresult: (e: unknown) => void } }).__rec;
        r.onresult({
          resultIndex: from,
          results: results.map(([t, f]) => Object.assign([{ transcript: t }], { isFinal: f })),
        });
      },
      { results, from },
    );
  let reply = listen(request);
  await expect(voice.getByLabel('speakNow')).toBeVisible();
  await emit([['is it', false]], 0);
  await emit([['is it active right', false]], 0);
  await emit([['is it active right now', true]], 0);
  await voice.clock.fastForward(1500);
  let text = await (await reply).text();
  expect(text).toMatch(/\] is it active right now$/);
  reply = ask(request, { kind: 'stt', ack: Number(/turn (\d+)/.exec(text)?.[1]) });
  await expect(voice.getByLabel('speakNow')).toBeVisible();
  // The mic stays on between listens, so the same session keeps growing: the first turn's
  // result stays at index 0 and is not sent again.
  const first: [string, boolean] = ['is it active right now', true];
  await emit([first, ['is it', true]], 1);
  await emit([first, ['is it', true], [' active right', false]], 2);
  await emit([first, ['is it', true], [' active right now', true]], 2);
  await voice.clock.fastForward(1500);
  text = await (await reply).text();
  expect(text).toMatch(/\] is it active right now$/);
});

test('Dark Reader is locked out and the theme setting applies', async ({ voice }) => {
  await expect(voice.locator('meta[name="darkreader-lock"]')).toHaveCount(1);
  for (const [theme, dark] of [
    ['light', false],
    ['dark', true],
  ] as const) {
    await voice.evaluate((t) => localStorage.setItem('__stts__theme', t), theme);
    await reload(voice);
    expect(await voice.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(dark);
  }
});

test('an automatic mic restart plays no chime', async ({ voice, request }) => {
  const chimes: string[] = [];
  voice.on('request', (r) => {
    if (r.url().includes('/earcon/listen-open')) chimes.push(r.url());
  });
  // The fixture turns earcons off in an init script; a later one turns them back on.
  await voice.addInitScript(() => localStorage.setItem('__stts__cues', 'chime'));
  await reload(voice);
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

test('spoken cues: Speak when the listen opens, Stop when the turn is sent, nothing on a restart', async ({
  voice,
  request,
}) => {
  const said: string[] = [];
  const piper = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      said.push((JSON.parse(body) as { text: string }).text);
      res.writeHead(200, { 'content-type': 'audio/wav' }).end(wav());
    });
  });
  piper.listen(testPort + 1, '127.0.0.1');
  await once(piper, 'listening');
  try {
    await voice.addInitScript(() => localStorage.setItem('__stts__cues', 'words'));
    await reload(voice);
    // This test's Piper is already up: answer and listen without the helper's own.
    const reply = ask(request, { kind: 'tts', text: 'Okay.' }).then(() => ask(request, { kind: 'stt' }));
    await expect(voice.getByLabel('speakNow')).toBeVisible();
    await expect.poll(() => said.filter((t) => t === 'Speak.').length).toBe(1);
    await voice.evaluate(() =>
      (globalThis as unknown as { __rec: { onerror: (e: unknown) => void } }).__rec.onerror({ error: 'network' }),
    );
    await voice.clock.fastForward(3000);
    await expect.poll(daemonLog).toMatch(/mic restart #\d+: mic error/);
    expect(said.filter((t) => t === 'Speak.').length).toBe(1);
    await say(voice, 'that is all for now');
    await voice.clock.fastForward(1500);
    expect(await (await reply).text()).toMatch(/that is all for now$/);
    await expect.poll(() => said.includes('Stop.')).toBe(true);
  } finally {
    piper.close();
  }
});

test('spoken cue: Speak plays when the light goes green right after the agent speaks', async ({ voice, request }) => {
  const said: string[] = [];
  const piper = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      said.push((JSON.parse(body) as { text: string }).text);
      res.writeHead(200, { 'content-type': 'audio/wav' }).end(wav());
    });
  });
  piper.listen(testPort + 1, '127.0.0.1');
  await once(piper, 'listening');
  try {
    await voice.addInitScript(() => localStorage.setItem('__stts__cues', 'words'));
    await reload(voice);
    // A reply with listen: the mic runs through the speech, so the light goes speaking -> green.
    const reply = ask(request, { kind: 'tts', text: 'Here is my answer.', listen: true });
    await expect(voice.getByLabel('speakNow')).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => said.filter((t) => t === 'Speak.').length).toBe(1);
    await say(voice, 'thanks that works');
    await voice.clock.fastForward(1500);
    expect(await (await reply).text()).toMatch(/thanks that works$/);
  } finally {
    piper.close();
  }
});

test('a pause mid-sentence loses nothing: both parts arrive, short or long pause', async ({ voice, request }) => {
  // Short pause: the hold (2 s after an unfinished word) waits for the rest.
  let reply = listen(request);
  await expect(voice.getByLabel('speakNow')).toBeVisible();
  await say(voice, 'I was looking at the');
  await voice.clock.fastForward(1000);
  await say(voice, 'colour tiles on the page');
  await voice.clock.fastForward(2500);
  let text = await (await reply).text();
  expect(text).toMatch(/I was looking at the colour tiles on the page$/);
  // Long pause: the unfinished part goes out, the listen stays open, and the daemon joins the rest.
  reply = ask(request, { kind: 'stt', ack: Number(/turn (\d+)/.exec(text)?.[1]) });
  await expect(voice.getByLabel('speakNow')).toBeVisible();
  await say(voice, 'and then I wanted to');
  await voice.clock.fastForward(3500);
  await say(voice, 'change the colours too');
  await voice.clock.fastForward(1500);
  text = await (await reply).text();
  expect(text).toMatch(/and then I wanted to change the colours too$/);
});

test('30 s of continuous speech is one turn, even when the recogniser goes quiet for seconds', async ({
  voice,
  request,
}) => {
  test.setTimeout(120_000);
  const level = (v: number) => voice.evaluate((x) => ((globalThis as unknown as { __level: number }).__level = x), v);
  const reply = listen(request);
  await expect(voice.getByLabel('speakNow')).toBeVisible({ timeout: 15_000 });
  await level(0.3); // his voice is on the mic for the whole 30 s
  const parts = [
    'first I want to say this',
    'then I keep going without a pause',
    'and here is more',
    'right to the end',
  ];
  for (const p of parts) {
    await say(voice, p);
    // The recogniser gives nothing for 7.5 s while he talks: no turn may go out.
    for (let i = 0; i < 15; i++) await voice.clock.fastForward(500);
  }
  await level(0);
  await voice.clock.fastForward(2000);
  const text = await (await reply).text();
  expect(text).toMatch(new RegExp(`\\] ${parts.join(' ')}$`));
});

test('every header button has a tooltip and responds', async ({ voice }) => {
  for (const label of ['Mute', 'Stop', 'Skip to listening (Esc)', 'Settings', 'End conversation']) {
    await expect(voice.getByRole('button', { name: label })).toHaveAttribute('title', label);
  }
  await voice.getByRole('button', { name: 'Mute' }).click();
  await expect(voice.getByRole('button', { name: 'Unmute' })).toBeVisible();
  await voice.getByRole('button', { name: 'Unmute' }).click();
  await expect(voice.getByRole('button', { name: 'Switch to keyboard input' })).toHaveCount(0);
  await expect(voice.getByLabel('Message')).toBeVisible();
  // A click anywhere off a control puts the cursor in the box; a button click still acts.
  await voice.getByLabel('Message').blur();
  await voice.locator('[data-orb]').click({ force: true });
  await expect(voice.getByLabel('Message')).toBeFocused();
  await voice.getByRole('button', { name: 'Mute' }).click();
  await expect(voice.getByRole('button', { name: 'Unmute' })).toBeVisible();
  await voice.getByRole('button', { name: 'Unmute' }).click();
  await expect(voice.getByRole('button', { name: 'Send' })).toHaveAttribute('title', 'Send');
  await voice.getByRole('button', { name: 'Settings' }).click();
  await expect(voice.getByLabel('Theme')).toBeVisible();
  await expect(voice.getByLabel('Turn cues')).toBeVisible();
});

// Last: End shuts the window.
test('End reaches the open listen once; the next call carries on', async ({ voice, request }) => {
  const reply = listen(request);
  await expect(voice.getByLabel('speakNow')).toBeVisible();
  // A test tab is not script-closable (it navigated), so record the call; the real --app window
  // closes (checked live, spec 003).
  await voice.evaluate(() => {
    window.close = () => document.body.setAttribute('data-closed', '');
  });
  await voice.getByLabel('End conversation').click();
  expect(await (await reply).text()).toBe(CONVERSATION_ENDED);
  // End shuts the window (Mark 2026-10-10).
  await expect(voice.locator('body[data-closed]')).toHaveCount(1);
  const next = ask(request, { kind: 'stt', idleSec: 1 });
  await voice.clock.fastForward(1500);
  expect(await (await next).text()).not.toBe(CONVERSATION_ENDED);
});
