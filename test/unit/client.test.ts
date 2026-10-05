import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawned = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: () => {
    spawned();
    return { unref() {} };
  },
}));

const c = await import('../../src/client.ts');

type Route = (init?: RequestInit) => Response | Promise<Response>;
let routes: Record<string, Route>;
const calls: string[] = [];

beforeEach(() => {
  spawned.mockClear();
  calls.length = 0;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`;
    calls.push(key);
    const r = routes[key];
    if (!r) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    return r(init);
  });
});

const ping = (dir: string) => () => new Response('ok', { headers: { 'X-Stts-Dir': dir } });
const body = { kind: 'stt', who: 'session' } as const;

describe('client', () => {
  it('pings then posts when the daemon is ours', async () => {
    routes = { 'GET /api/ping': ping(c.ourDir), 'POST /request': () => new Response('[turn 1] hi') };
    expect(await c.request(body)).toBe('[turn 1] hi');
    expect(calls).toEqual(['GET /api/ping', 'POST /request']);
    expect(spawned).not.toHaveBeenCalled();
  });

  it('retires a stale-dir daemon with no window open and respawns', async () => {
    routes = {
      'GET /api/ping': ping('C:/old'),
      'GET /barge': () => Response.json({ text: '', open: false }),
      'POST /api/shutdown': () => {
        routes['GET /api/ping'] = ping(c.ourDir);
        return new Response('ok');
      },
      'POST /request': () => new Response('x'),
    };
    expect(await c.request(body)).toBe('x');
    expect(calls).toContain('POST /api/shutdown');
    expect(spawned).toHaveBeenCalledOnce();
  });

  it('leaves a stale-dir daemon alone while its window is open', async () => {
    routes = {
      'GET /api/ping': ping('C:/old'),
      'GET /barge': () => Response.json({ text: '', open: true }),
      'POST /request': () => new Response('x'),
    };
    expect(await c.request(body)).toBe('x');
    expect(calls).not.toContain('POST /api/shutdown');
    expect(spawned).not.toHaveBeenCalled();
  });

  it('respawns and retries once when the daemon drops the connection', async () => {
    let n = 0;
    routes = {
      'GET /api/ping': ping(c.ourDir),
      'POST /request': () => {
        n++;
        if (n === 1) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
        return new Response('again');
      },
    };
    expect(await c.request(body)).toBe('again');
    expect(n).toBe(2);
  });

  it('does not retry twice', async () => {
    routes = {
      'GET /api/ping': ping(c.ourDir),
      'POST /request': () => {
        throw new TypeError('fetch failed', { cause: { code: 'EPIPE' } });
      },
    };
    await expect(c.request(body)).rejects.toThrow('fetch failed');
  });

  it('surfaces a non-200 reply with its text', async () => {
    routes = { 'GET /api/ping': ping(c.ourDir), 'POST /request': () => new Response('superseded', { status: 504 }) };
    await expect(c.request(body)).rejects.toThrow('stts daemon returned 504: superseded');
  });

  it('daemonGone only matches the three codes', () => {
    expect(c.daemonGone(new TypeError('x', { cause: { code: 'ECONNREFUSED' } }))).toBe(true);
    expect(c.daemonGone(new Error('AbortError'))).toBe(false);
    expect(c.daemonGone(undefined)).toBe(false);
  });
});
