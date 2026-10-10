import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  app,
  attachPage,
  deps,
  exitCodeWhenTaken,
  REOPEN_FIRST_MS,
  resetTurns,
  slotId,
  WINDOW_OPEN_MS,
} from '../../src/daemon.ts';
import {
  BACKGROUND_RESULT,
  bargeLine,
  CONVERSATION_ENDED,
  type DaemonMessage,
  LISTEN_CONTINUES,
  SUPERSEDED,
  TURN_PREFIX,
} from '../../src/protocol.ts';

const logs: string[] = [];
const exits: number[] = [];
deps.log = (l) => void logs.push(l);
deps.exit = (c) => void exits.push(c);
deps.openWindow = async () => {};

const post = (path: string, body?: unknown) =>
  app.request(path, { method: 'POST', body: body === undefined ? null : JSON.stringify(body) });
const tick = () => new Promise((r) => setTimeout(r, 0));

let sent: DaemonMessage[];
let page: ReturnType<typeof attachPage>;
beforeEach(() => {
  sent = [];
  logs.length = 0;
  exits.length = 0;
  resetTurns();
  page = attachPage((m) => void sent.push(m));
});
afterEach(() => {
  page.detach();
  delete process.env['STTS_REQUEST_TIMEOUT_MS'];
});

const speak = (text: string) => page.onMessage(JSON.stringify({ type: 'complete', text, startAt: 0, endAt: 1000 }));

describe('daemon', () => {
  it('a window that never connects times out after 15 s and the next send relaunches', async () => {
    page.detach();
    vi.useFakeTimers();
    let opens = 0;
    deps.openWindow = async () => void opens++;
    try {
      void post('/request', { kind: 'stt' });
      await vi.advanceTimersByTimeAsync(0);
      expect(opens).toBe(1);
      await vi.advanceTimersByTimeAsync(WINDOW_OPEN_MS);
      expect(logs).toContain('window open timed out');
      void post('/request', { kind: 'stt' });
      await vi.advanceTimersByTimeAsync(0);
      expect(opens).toBe(2);
    } finally {
      deps.openWindow = async () => {};
      vi.useRealTimers();
    }
  });

  it('a launcher that throws, even synchronously, logs once and never throws out of send', async () => {
    page.detach();
    deps.openWindow = () => {
      throw new TypeError("Cannot read properties of undefined (reading 'on')");
    };
    try {
      void post('/request', { kind: 'stt' });
      await tick();
      await tick();
      expect(logs.filter((l) => l.startsWith('chrome launch failed'))).toEqual([
        "chrome launch failed Cannot read properties of undefined (reading 'on')",
      ]);
    } finally {
      deps.openWindow = async () => {};
    }
  });

  it('ping answers ok with X-Stts-Dir', async () => {
    const r = await app.request('/api/ping');
    expect(await r.text()).toBe('ok');
    expect(r.headers.get('X-Stts-Dir')).toBeTruthy();
  });

  it('never replays: a tts with listen resends only its listen (join, reconnect, unmute)', async () => {
    const r = post('/request', { kind: 'tts', text: 'Hi, I am here.', listen: true });
    await tick();
    expect(sent.filter((m) => m.type === 'request')).toHaveLength(1);
    // An unfinished sentence keeps the listen open and the slot is resent: listen only.
    speak('I want to go to the');
    page.onMessage(JSON.stringify({ type: 'ready' }));
    page.onMessage(JSON.stringify({ type: 'relisten' }));
    const again = sent.filter((m) => m.type === 'request').slice(1);
    expect(again.length).toBeGreaterThan(0);
    for (const m of again) expect(m.type === 'request' && m.body.kind).toBe('stt');
    speak('shop now please');
    expect(await (await r).text()).toMatch(TURN_PREFIX);
  });

  it('speech with no listen open is held for the next listen', async () => {
    speak('said after a stop');
    expect(logs).toContain('page heard held for the next listen');
    const r = post('/request', { kind: 'stt' });
    expect(await (await r).text()).toMatch(/said after a stop$/);
  });

  it('speech while a speak-only tts is open is held, not lost', async () => {
    const t = post('/request', { kind: 'tts', text: 'working on it' });
    await tick();
    speak('and one more thing');
    expect(logs).toContain('page heard held for the next listen');
    page.onMessage(JSON.stringify({ type: 'complete', text: '', startAt: 0, endAt: 0 }));
    await t;
    expect(await (await post('/request', { kind: 'stt' })).text()).toMatch(/and one more thing$/);
  });

  it('a newer request supersedes the old one with 504 and released', async () => {
    const first = post('/request', { kind: 'stt' });
    await tick();
    const second = post('/request', { kind: 'stt' });
    const r1 = await first;
    expect(r1.status).toBe(504);
    expect(await r1.text()).toBe(SUPERSEDED);
    expect(sent).toContainEqual({ type: 'released', reason: 'superseded' });
    await tick();
    speak('hello there');
    const r2 = await second;
    expect(r2.status).toBe(200);
    expect(await r2.text()).toMatch(TURN_PREFIX);
    expect(slotId()).toBeNull();
  });

  it('a listen past the budget continues, and the carry joins the next listen', async () => {
    process.env['STTS_REQUEST_TIMEOUT_MS'] = '20';
    const r = await post('/request', { kind: 'stt' });
    expect(await r.text()).toBe(LISTEN_CONTINUES);
    expect(sent).toContainEqual({ type: 'released', reason: 'timeout' });
    speak('half said');
    delete process.env['STTS_REQUEST_TIMEOUT_MS'];
    const next = post('/request', { kind: 'stt' });
    await tick();
    speak('and the rest');
    expect(await (await next).text()).toMatch(/\] half said and the rest$/);
  });

  it('/notify ends an open listen with the background result', async () => {
    const listen = post('/request', { kind: 'stt' });
    await tick();
    expect(await (await post('/notify')).text()).toBe('ok');
    expect(await (await listen).text()).toBe(BACKGROUND_RESULT);
    expect(sent).toContainEqual({ type: 'released', reason: 'background' });
  });

  it('/notify?delayMs releases the listen only after the delay', async () => {
    const listen = post('/request', { kind: 'stt' });
    await tick();
    expect(await (await post('/notify?delayMs=300')).text()).toBe('ok');
    await new Promise((r) => setTimeout(r, 100));
    expect(slotId()).not.toBeNull();
    expect(await (await listen).text()).toBe(BACKGROUND_RESULT);
    await post('/notify?delayMs=junk'); // a bad value means at once; nothing is open, so nothing happens
    expect(slotId()).toBeNull();
  });

  it('/notify with no listen open changes nothing', async () => {
    const speech = post('/request', { kind: 'tts', text: 'hi' });
    await tick();
    await post('/notify');
    expect(slotId()).not.toBeNull();
    speak('');
    expect(await (await speech).text()).toBe('Spoken.');
    expect(sent.some((m) => m.type === 'released')).toBe(false);
  });

  const typed = (text: string, extra: object = {}) =>
    page.onMessage(JSON.stringify({ type: 'complete', text, startAt: 0, endAt: 1000, source: 'typed', ...extra }));

  it('a typed complete returns the turn prefix and logs a typed turn', async () => {
    const r = post('/request', { kind: 'stt' });
    await tick();
    typed('typed hello');
    expect(await (await r).text()).toMatch(/^\[turn 1, typed [\d:]+ to [\d:]+\] typed hello$/);
    expect(logs).toContain('page typed turn 1');
  });

  it('a typed message with no listen open is held for the next listen', async () => {
    typed('sent while no one listened');
    expect(await (await post('/request', { kind: 'stt' })).text()).toMatch(/\] sent while no one listened$/);
  });

  it('a barge cuts the tts off and returns the turn with the barge note', async () => {
    const speech = post('/request', { kind: 'tts', text: 'a long answer' });
    await tick();
    typed('wait, also check the logs', { interrupted: { part: 2, sentence: 3 } });
    speak(''); // the stopped speech's own complete
    const text = await (await speech).text();
    expect(text).toMatch(TURN_PREFIX);
    expect(text).toBe(`${text.split('\n')[0]}\n${bargeLine(2, 3)}`);
    expect(text).toContain('wait, also check the logs');
  });

  it('/barge has the old shape', async () => {
    expect(await (await app.request('/barge')).json()).toEqual({ text: '', open: true });
    page.detach();
    expect(await (await app.request('/barge')).json()).toEqual({ text: '', open: false });
  });

  it('close from a helper agent is ignored', async () => {
    const r = post('/request', { kind: 'tts', text: 'bye', close: true, who: 'agent' });
    await tick();
    const req = sent.find((m) => m.type === 'request');
    expect(req?.type === 'request' && req.body.close).toBe(false);
    speak('');
    await r;
    expect(sent.some((m) => m.type === 'close')).toBe(false);
  });

  it('a session tts with close shuts the window once it has spoken', async () => {
    const r = post('/request', { kind: 'tts', text: 'bye', close: true });
    await tick();
    expect(sent.some((m) => m.type === 'close')).toBe(false);
    speak('');
    await r;
    expect(sent.at(-1)).toEqual({ type: 'close' });
  });

  it('page ended answers the conversation-ended sentinel', async () => {
    const r = post('/request', { kind: 'stt' });
    await tick();
    page.onMessage(JSON.stringify({ type: 'ended' }));
    expect(await (await r).text()).toBe(CONVERSATION_ENDED);
    expect(sent.at(-1)).toEqual({ type: 'close' }); // End shuts the window (Mark 2026-10-10)
    await new Promise((res) => setTimeout(res, 600));
    expect(exits).toEqual([]); // the daemon keeps the port: an older client must not start its own
    // An End reaches exactly one reply: a stale press never ends a later session (2026-10-07).
    const again = post('/request', { kind: 'stt' });
    await tick();
    expect(sent.at(-1)).toMatchObject({ type: 'request' });
    speak('back again');
    expect(await (await again).text()).toMatch(/back again$/);
  });

  it('an End pressed with no call open is kept for the next call, once', async () => {
    page.onMessage(JSON.stringify({ type: 'ended' }));
    expect(await (await post('/request', { kind: 'tts', text: 'hi' })).text()).toBe(CONVERSATION_ENDED);
    const next = post('/request', { kind: 'stt' });
    await tick();
    speak('still here');
    expect(await (await next).text()).toMatch(/still here$/);
  });

  it('an End pressed mid-speech ends that tts', async () => {
    const r = post('/request', { kind: 'tts', text: 'a long sentence', listen: true });
    await tick();
    page.onMessage(JSON.stringify({ type: 'ended' }));
    expect(await (await r).text()).toBe(CONVERSATION_ENDED);
  });

  it('a closed window is not an End', async () => {
    const r = post('/request', { kind: 'stt' });
    await tick();
    page.onMessage(JSON.stringify({ type: 'close' }));
    expect(await (await r).text()).not.toBe(CONVERSATION_ENDED);
    const next = post('/request', { kind: 'stt' });
    await tick();
    speak('reopened');
    expect(await (await next).text()).toMatch(/reopened$/);
  });

  // Mark 2026-10-10: a window closed by accident or crashed mid-listen came back only on the next call.
  it('a window killed mid-listen reopens, the listen resumes, and a crash loop backs off', async () => {
    vi.useFakeTimers();
    let opens = 0;
    deps.openWindow = async () => void opens++;
    try {
      const r = post('/request', { kind: 'stt' });
      await vi.advanceTimersByTimeAsync(0);
      page.detach(); // the window is killed
      await vi.advanceTimersByTimeAsync(REOPEN_FIRST_MS - 1);
      expect(opens).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(opens).toBe(1);
      expect(logs).toContain(`window gone mid-call: reopening the window in ${REOPEN_FIRST_MS}ms`);
      // It crashes again at once: the next reopen waits twice as long.
      page = attachPage((m) => void sent.push(m));
      page.detach();
      await vi.advanceTimersByTimeAsync(2 * REOPEN_FIRST_MS - 1);
      expect(opens).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(opens).toBe(2);
      // This time it stays: its ready resends the open listen, and the call returns his words.
      sent.length = 0;
      page = attachPage((m) => void sent.push(m));
      page.onMessage(JSON.stringify({ type: 'ready' }));
      expect(sent.at(-1)).toMatchObject({ type: 'request', body: { kind: 'stt' } });
      speak('still with you');
      await vi.advanceTimersByTimeAsync(5000);
      expect(await (await r).text()).toMatch(/still with you$/);
    } finally {
      deps.openWindow = async () => {};
      vi.useRealTimers();
    }
  });

  it('End and close=true shut the window for good; a page reload never relaunches', async () => {
    vi.useFakeTimers();
    let opens = 0;
    deps.openWindow = async () => void opens++;
    try {
      const r = post('/request', { kind: 'stt' });
      await vi.advanceTimersByTimeAsync(0);
      page.onMessage(JSON.stringify({ type: 'ended' }));
      expect(await (await r).text()).toBe(CONVERSATION_ENDED);
      page.detach();
      const t = post('/request', { kind: 'tts', text: 'bye', close: true });
      await vi.advanceTimersByTimeAsync(0);
      // The End was taken by the first call; this tts opens a window as any new call does.
      expect(opens).toBe(1);
      page = attachPage((m) => void sent.push(m));
      page.onMessage(JSON.stringify({ type: 'ready' }));
      speak('');
      await t;
      expect(sent.at(-1)).toEqual({ type: 'close' });
      page.detach();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(opens).toBe(1);
      // A reload mid-listen: the page is back before the reopen fires, so nothing launches.
      page = attachPage((m) => void sent.push(m));
      const l = post('/request', { kind: 'stt' });
      await vi.advanceTimersByTimeAsync(0);
      page.detach();
      page = attachPage((m) => void sent.push(m));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(opens).toBe(1);
      speak('after the reload');
      await vi.advanceTimersByTimeAsync(5000);
      expect(await (await l).text()).toMatch(/after the reload$/);
    } finally {
      deps.openWindow = async () => {};
      vi.useRealTimers();
    }
  });

  it('a bad ws message is logged and dropped', () => {
    page.onMessage('{"type":"nope"}');
    page.onMessage('not json');
    expect(logs).toEqual(['ws bad message', 'ws bad message']);
  });

  it('page log lines are prefixed with page', () => {
    page.onMessage(JSON.stringify({ type: 'log', line: 'mic restart #2: no result' }));
    expect(logs).toEqual(['page mic restart #2: no result']);
  });

  it('1000 supersedes leave no leaked slot', async () => {
    const all = Array.from({ length: 1000 }, () => post('/request', { kind: 'stt' }));
    await tick();
    speak('last');
    const rs = await Promise.all(all);
    expect(rs.filter((r) => r.status === 504)).toHaveLength(999);
    expect(rs.at(-1)?.status).toBe(200);
    expect(slotId()).toBeNull();
  }, 20_000); // 1000 requests: slow under load (the parallel e2e runs), not a leak.

  it('a second instance exits 0 when the port answers ok', async () => {
    const live = new Hono().get('/api/ping', (c) => c.text('ok'));
    const server = serve({ fetch: live.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise((r) => server.once('listening', r));
    const addr = server.address();
    const p = typeof addr === 'object' && addr ? addr.port : 0;
    expect(await exitCodeWhenTaken(p)).toBe(0);
    server.close();
    expect(await exitCodeWhenTaken(p)).toBe(1);
  });

  it('an empty complete during a listen is not a turn', async () => {
    const listen = post('/request', { kind: 'stt' });
    await tick();
    speak('');
    expect(slotId()).not.toBeNull();
    speak('real words');
    expect(await (await listen).text()).toMatch(/\] real words$/);
  });

  it('/voice/clip refuses a bad body or a voice with a path in it', async () => {
    expect((await post('/voice/clip', null)).status).toBe(400);
    expect((await post('/voice/clip', { text: 'hi', voice: '../x' })).status).toBe(400);
  });
});
