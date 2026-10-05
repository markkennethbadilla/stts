import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app, attachPage, deps, exitCodeWhenTaken, resetTurns, slotId } from '../../src/daemon.ts';
import {
  BACKGROUND_RESULT,
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
  it('ping answers ok with X-Stts-Dir', async () => {
    const r = await app.request('/api/ping');
    expect(await r.text()).toBe('ok');
    expect(r.headers.get('X-Stts-Dir')).toBeTruthy();
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

  it('/notify with no listen open changes nothing', async () => {
    const speech = post('/request', { kind: 'tts', text: 'hi' });
    await tick();
    await post('/notify');
    expect(slotId()).not.toBeNull();
    speak('');
    expect(await (await speech).text()).toBe('Spoken.');
    expect(sent.some((m) => m.type === 'released')).toBe(false);
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
  });

  it('page ended answers the conversation-ended sentinel', async () => {
    const r = post('/request', { kind: 'stt' });
    await tick();
    page.onMessage(JSON.stringify({ type: 'ended' }));
    expect(await (await r).text()).toBe(CONVERSATION_ENDED);
    expect(exits).toEqual([0]);
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
  });

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
