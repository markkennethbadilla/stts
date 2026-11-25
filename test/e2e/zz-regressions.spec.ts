// Regressions fixed on 2026-10-06; each test guards one behaviour Mark saw come back.
// Named zz- so it runs after voice.spec.ts: its last test presses End, which stops the daemon.
import type { APIRequestContext, Page } from '@playwright/test';
import { CONVERSATION_ENDED, NO_SPEECH } from '../../src/protocol.ts';
import { toClips } from '../../src/sentences.ts';
import { daemonLog, expect, holdSpeech, releaseSpeech, spokenTexts, test, voiceCount } from './fixtures.ts';

const emitResults = (voice: Page, results: [string, boolean][], from: number) =>
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

// A turn left unanswered by an earlier test makes a bare stt a 409: answer it with a short tts, then listen.
async function listen(request: APIRequestContext) {
  await ask(request, { kind: 'tts', text: 'Okay.' });
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
  const emit = (results: [string, boolean][], from: number) => emitResults(voice, results, from);
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

test('a turn sent on interim words keeps the tail its late final adds', async ({ voice, request }) => {
  const emit = (results: [string, boolean][], from: number) => emitResults(voice, results, from);
  let reply = listen(request);
  await expect(voice.getByLabel('speakNow')).toBeVisible();
  await emit([['tell me about the call', false]], 0);
  await voice.clock.fastForward(1500);
  let text = await (await reply).text();
  expect(text).toMatch(/\] tell me about the call$/);
  reply = ask(request, { kind: 'stt', ack: Number(/turn (\d+)/.exec(text)?.[1]) });
  await emit([['tell me about the call tomorrow morning', true]], 0);
  await voice.clock.fastForward(1500);
  text = await (await reply).text();
  expect(text).toMatch(/\] tomorrow morning$/);
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
  await holdSpeech(voice, 0);
  const speech = ask(request, {
    kind: 'tts',
    text: 'Our conversation would carry on, and the listen you have open stays open while it reloads.',
  });
  await expect(voice.getByLabel('agentSpeaking')).toBeVisible();
  await expect.poll(() => voice.evaluate(() => '__rec' in globalThis)).toBe(true);
  await say(voice, 'our conversations carry on');
  await expect.poll(daemonLog).toContain('page echo discarded');
  await expect(voice.getByLabel('agentSpeaking')).toBeVisible();
  await voice.getByLabel(/Skip/).click();
  expect(await (await speech).text()).not.toMatch(/\[turn/);
});

// Mark 2026-10-15: a new tts arrived while the last one still spoke; the new tts cuts the old one off for good.
test('a new tts mid-speech cuts the old speech off; only the new clips follow', async ({ voice, request }) => {
  await holdSpeech(voice, 1);
  const old = 'Old one. Old two is here. Old three is here. Old four is here.';
  const next = 'New one. New two is here.';
  const first = ask(request, { kind: 'tts', text: old, listen: true });
  await expect.poll(async () => (await spokenTexts(voice)).length).toBe(2);
  const second = ask(request, { kind: 'tts', text: next });
  expect(await (await first).text()).not.toMatch(/\[turn/);
  await expect.poll(async () => (await spokenTexts(voice)).includes('New one.')).toBe(true);
  for (let i = 0; i < 20 && (await spokenTexts(voice)).at(-1) !== 'New two is here.'; i++) {
    await releaseSpeech(voice);
    await voice.waitForTimeout(100);
  }
  await releaseSpeech(voice);
  await second;
  const said = await spokenTexts(voice);
  const from = said.indexOf('New one.');
  expect(said.slice(from)).toEqual(['New one.', 'New two is here.']);
  expect(said.slice(0, from).every((s) => s.startsWith('Old'))).toBe(true);
  expect(said).not.toContain('Old three is here.');
});

// Mark 2026-11-05: his first words keep the speech paused until his final, then it is cut off for good.
test('a long sentence over the speech keeps it paused until his final, then barges', async ({ voice, request }) => {
  await holdSpeech(voice, 0);
  const speech = ask(request, { kind: 'tts', text: 'A long reply about the hold that he talks over for a while.' });
  await expect(voice.getByLabel('agentSpeaking')).toBeVisible();
  await expect.poll(() => voice.evaluate(() => '__rec' in globalThis)).toBe(true);
  await voice.clock.fastForward(700);
  const resumes = await voiceCount(voice, 'resumes');
  await voice.evaluate(() => (globalThis as unknown as { __rec: { onspeechstart: () => void } }).__rec.onspeechstart());
  // His first interim words confirm the barge: past the 3 s hold the speech must stay paused.
  await voice.evaluate(() => {
    const r = (globalThis as unknown as { __rec: { onresult: (e: unknown) => void } }).__rec;
    r.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'no wait I want' }], { isFinal: false })] });
  });
  await voice.clock.fastForward(4000);
  expect(await voiceCount(voice, 'resumes')).toBe(resumes);
  const said = 'no wait I want you to explain the other option first';
  await voice.evaluate((t) => {
    const r = (globalThis as unknown as { __rec: { onresult: (e: unknown) => void } }).__rec;
    r.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: t }], { isFinal: true })] });
  }, said);
  const text = await (await speech).text();
  expect(text.split('\n')[0]).toMatch(new RegExp(`\\] ${said}$`));
  expect(text).toContain('interrupted your speech at part 1 sentence 1');
  expect(await voiceCount(voice, 'resumes')).toBe(resumes);
});

// Mark 2026-10-15: speech pauses the moment his voice starts, and resumes if the final turns out to be echo.
test('his voice starting over the speech pauses it at once; an echo final resumes it', async ({ voice, request }) => {
  await holdSpeech(voice, 0);
  const speech = ask(request, {
    kind: 'tts',
    text: 'Our conversation would carry on, and the listen you have open stays open while it reloads.',
  });
  await expect(voice.getByLabel('agentSpeaking')).toBeVisible();
  await expect.poll(() => voice.evaluate(() => '__rec' in globalThis)).toBe(true);
  await voice.evaluate(() => (globalThis as unknown as { __rec: { onspeechstart: () => void } }).__rec.onspeechstart());
  expect(await voiceCount(voice, 'pauses')).toBe(1);
  await say(voice, 'our conversations carry on');
  await expect.poll(() => voiceCount(voice, 'resumes')).toBe(1);
  await voice.getByLabel(/Skip/).click();
  expect(await (await speech).text()).not.toMatch(/\[turn/);
});

// Mark 2026-10-30: his first non-echo words stop the speech for good, final or not.
test('his first words over the speech stop it for good, final or not', async ({ voice, request }) => {
  await holdSpeech(voice, 0);
  const speech = ask(request, {
    kind: 'tts',
    text: 'Here is the long plan for the migration of every service to the new cluster.',
  });
  await expect(voice.getByLabel('agentSpeaking')).toBeVisible();
  await expect.poll(() => voice.evaluate(() => '__rec' in globalThis)).toBe(true);
  // Past BARGE_MIN_MS into the clip: words sooner are its own echo, never a hard stop.
  await voice.clock.fastForward(700);
  // A fast-forward through animation frames takes real seconds, so the 10 s final wait is lengthened here.
  await voice.evaluate(() => {
    (globalThis as unknown as { __sttsBargeFinalWaitMs: number }).__sttsBargeFinalWaitMs = 600_000;
  });
  const resumes = await voiceCount(voice, 'resumes');
  await voice.evaluate(() => {
    const r = (globalThis as unknown as { __rec: { onspeechstart: () => void; onresult: (e: unknown) => void } }).__rec;
    r.onspeechstart();
    r.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'hold on a' }], { isFinal: false })] });
  });
  // A long sentence: its final comes after 2.5 s. The speech stays stopped and the barge waits for the final.
  await voice.clock.fastForward(3000);
  expect(await voiceCount(voice, 'resumes')).toBe(resumes);
  const long = 'hold on a second I need you to change the whole plan first';
  await voice.evaluate((t) => {
    const r = (globalThis as unknown as { __rec: { onresult: (e: unknown) => void } }).__rec;
    r.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: t }], { isFinal: true })] });
  }, long);
  const text = await (await speech).text();
  expect(text.split('\n')[0]).toMatch(new RegExp(`\\] ${long}$`));
  // The sentence is never sent again: nothing held for the next listen repeats it.
  await voice.clock.fastForward(1500);
  const held = (await (await voice.request.post('/held')).json()) as { text: string };
  expect(held.text).not.toContain('whole plan');
  // The second listen after the barge opens and runs its idle timer like any other.
  const turn = Number(/turn (\d+)/.exec(text)?.[1]);
  const second = ask(request, { kind: 'stt', ack: turn, idleSec: 2 });
  await expect(voice.getByLabel('speakNow')).toBeVisible();
  await voice.clock.fastForward(2500);
  expect(await (await second).text()).toBe(NO_SPEECH);
});

test('the first clip is short; the clips follow one at a time, in order', async ({ voice, request }) => {
  const text =
    'Good point. A helper is updating the rules so a phone push means asking you. ' +
    'The vault note says the same thing, and nothing else changes today. That is all for now.';
  await ask(request, { kind: 'tts', text });
  const said = await spokenTexts(voice);
  expect(said[0]).toBe('Good point.');
  expect(said).toEqual(toClips(text, 120));
});

test('spoken cues: Speak when the listen opens, Stop when the turn is sent, nothing on a restart', async ({
  voice,
  request,
}) => {
  await voice.addInitScript(() => localStorage.setItem('__stts__cues', 'words'));
  await reload(voice);
  const reply = ask(request, { kind: 'tts', text: 'Okay.' }).then(() => ask(request, { kind: 'stt' }));
  await expect(voice.getByLabel('speakNow')).toBeVisible();
  const cue = async (w: string) => (await spokenTexts(voice)).filter((t) => t === w).length;
  await expect.poll(() => cue('Speak.')).toBe(1);
  await voice.evaluate(() =>
    (globalThis as unknown as { __rec: { onerror: (e: unknown) => void } }).__rec.onerror({ error: 'network' }),
  );
  await voice.clock.fastForward(3000);
  await expect.poll(daemonLog).toMatch(/mic restart #\d+: mic error/);
  expect(await cue('Speak.')).toBe(1);
  await say(voice, 'that is all for now');
  await voice.clock.fastForward(1500);
  expect(await (await reply).text()).toMatch(/that is all for now$/);
  await expect.poll(() => cue('Stop.')).toBe(1);
});

test('spoken cue: Speak plays when the light goes green right after the agent speaks', async ({ voice, request }) => {
  await voice.addInitScript(() => localStorage.setItem('__stts__cues', 'words'));
  await reload(voice);
  // A reply with listen: the mic runs through the speech, so the light goes speaking -> green.
  const reply = ask(request, { kind: 'tts', text: 'Here is my answer.', listen: true });
  await expect(voice.getByLabel('speakNow')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await spokenTexts(voice)).filter((t) => t === 'Speak.').length).toBe(1);
  await say(voice, 'thanks that works');
  await voice.clock.fastForward(1500);
  expect(await (await reply).text()).toMatch(/thanks that works$/);
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
    // The recogniser gives nothing for 5 s while he talks: no turn may go out. Past 6 s with no new
    // words a turn goes anyway (MAX_TALK_HOLD_MS, Mark 2026-10-27: steady noise held turns forever).
    for (let i = 0; i < 10; i++) await voice.clock.fastForward(500);
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
// Mark 2026-10-10: a mic plugged in after the window opened (the Iriun Webcam mic) never showed up.
test('a mic plugged in later is listed, picking it switches the open mic, unplugging it falls back', async ({
  voice,
  request,
}) => {
  // A device list the test controls, and every getUserMedia device recorded.
  await voice.addInitScript(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    const dev = (deviceId: string, label: string) => ({ deviceId, label, kind: 'audioinput', groupId: deviceId });
    g['__devices'] = [dev('default', 'Default'), dev('laptop', 'Laptop Mic')];
    g['__gum'] = [] as string[];
    g['__plug'] = (on: boolean) => {
      const list = (g['__devices'] as ReturnType<typeof dev>[]).filter((d) => d.deviceId !== 'iriun');
      g['__devices'] = on ? [...list, dev('iriun', 'Iriun Webcam')] : list;
      navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
    };
    const md = navigator.mediaDevices;
    md.enumerateDevices = async () => g['__devices'] as MediaDeviceInfo[];
    const real = md.getUserMedia.bind(md);
    md.getUserMedia = (c?: MediaStreamConstraints) => {
      const a = c?.audio;
      (g['__gum'] as string[]).push(typeof a === 'object' && a.deviceId ? String(a.deviceId) : 'default');
      return real({ audio: true });
    };
  });
  await reload(voice);
  const reply = listen(request);
  await expect(voice.getByLabel('speakNow')).toBeVisible();
  const gum = () => voice.evaluate(() => (globalThis as unknown as { __gum: string[] }).__gum);
  const plug = (on: boolean) =>
    voice.evaluate((x) => (globalThis as unknown as { __plug: (b: boolean) => void }).__plug(x), on);
  await voice.getByLabel('Settings').click();
  const micBox = voice.getByRole('combobox', { name: 'Mic' });
  await micBox.click();
  await expect(voice.getByRole('option', { name: 'Laptop Mic' })).toBeVisible();
  await expect(voice.getByRole('option', { name: 'Iriun Webcam' })).toHaveCount(0);
  await voice.keyboard.press('Escape');
  // Plugged in while the window is open: it is listed at once.
  await plug(true);
  await micBox.click();
  await voice.getByRole('option', { name: 'Iriun Webcam' }).click();
  // Picked while the mic is open: the open mic moves to it, no reload, no new listen.
  await expect.poll(gum).toContain('iriun');
  await expect.poll(daemonLog).toContain('page mic switched to a new device');
  // Let the switch finish (its recogniser starts on the fake clock) before the unplug, as a real
  // unplug never comes within milliseconds of the pick.
  await voice.clock.fastForward(300);
  await expect(voice.getByLabel('speakNow')).toBeVisible();
  // Unplugged: the setting falls back to the default and the open mic follows.
  const before = (await gum()).length;
  await plug(false);
  await expect.poll(() => voice.evaluate(() => localStorage.getItem('__stts__mic'))).toBe('default');
  // The restart after a second mic switch waits a backoff (250 ms and up) on the test's fake clock.
  await expect
    .poll(async () => {
      await voice.clock.fastForward(300);
      return (await gum()).slice(before);
    })
    .toContain('default');
  await expect(voice.getByLabel('speakNow')).toBeVisible();
  await voice.keyboard.press('Escape');
  // The reopened recogniser starts on a setTimeout, which runs only as the fake clock moves.
  await voice.clock.fastForward(300);
  await say(voice, 'the new mic works');
  await voice.clock.fastForward(1500);
  expect(await (await reply).text()).toMatch(/the new mic works$/);
});

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
