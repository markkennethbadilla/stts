// Daemon read-aloud, turns gate and the client <-> daemon /request contract, all through
// app.request() with no socket.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from '../../src/client.ts';
import { app, attachPage, deps, resetTurns } from '../../src/daemon.ts';
import { type DaemonMessage, NO_SPEECH, STOPPED, TURN_PREFIX, unansweredError } from '../../src/protocol.ts';

deps.log = () => {};
deps.exit = () => {};
deps.openWindow = async () => {};

const realFetch = globalThis.fetch;
let sent: DaemonMessage[];
let page: ReturnType<typeof attachPage>;
let pageAct: (m: DaemonMessage) => void;
beforeEach(() => {
  sent = [];
  pageAct = () => {};
  resetTurns();
  page = attachPage((m) => {
    sent.push(m);
    queueMicrotask(() => pageAct(m));
  });
  // The client's fetch goes to the hono app; anything else is the real network.
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
    url.startsWith('http://127.0.0.1:15986') ? app.request(new URL(url).pathname, init) : realFetch(url, init),
  );
});
afterEach(() => {
  page.detach();
  vi.unstubAllGlobals();
});

const say = (o: object) => page.onMessage(JSON.stringify(o));
// A page that speaks every tts at once and answers every listen with `words`.
const autoPage = (words: string) => {
  pageAct = (m) => {
    if (m.type !== 'request') return;
    if (m.body.kind === 'tts' && !m.body.listen) say({ type: 'complete', text: '', startAt: 0, endAt: 0 });
    else say({ type: 'complete', text: words, startAt: Date.now(), endAt: Date.now() });
  };
};
const dir = mkdtempSync(join(tmpdir(), 'stts-'));
const file = (name: string, body: string) => {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
};
const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is here to fill the part.`).join(' ');

describe('client <-> daemon contract', () => {
  it('200 is the reply text', async () => {
    autoPage('hello');
    expect(await request({ kind: 'tts', who: 'session', text: 'hi' })).toBe('Spoken.');
    expect(await request({ kind: 'tts', who: 'session', text: 'hi', listen: true })).toMatch(/^\[turn 1, .*\] hello$/);
  });

  it('a heard turn, then an unanswered stt is the 409 text as the error', async () => {
    autoPage('hello there');
    expect(await request({ kind: 'stt', who: 'session' })).toMatch(/^\[turn 1, heard .*\] hello there$/);
    await expect(request({ kind: 'stt', who: 'session' })).rejects.toThrow(unansweredError(1));
    expect(await request({ kind: 'stt', who: 'session', ack: 1 })).toMatch(/^\[turn 2, /);
  });

  it('turn ids rise and a duplicate is dropped', async () => {
    pageAct = (m) => {
      if (m.type === 'request') say({ type: 'complete', text: 'same', startAt: 1000, endAt: 2000 });
    };
    const r = request({ kind: 'stt', who: 'session' });
    expect(await r).toMatch(/^\[turn 1, /);
    let n = 0;
    pageAct = (m) => {
      if (m.type !== 'request') return;
      n++;
      // First a repeat of the last turn (dropped, listen stays open), then new speech.
      say({ type: 'complete', text: n === 1 ? 'same' : 'new words', startAt: 2100, endAt: n === 1 ? 2500 : 4000 });
    };
    expect(await request({ kind: 'stt', who: 'session', ack: 1 })).toMatch(/^\[turn 2, .*\] new words$/);
  });

  it('bad input is a 400 whose text is the error', async () => {
    await expect(request({ kind: 'tts', who: 'session', file: join(dir, 'missing.txt') })).rejects.toThrow(/ENOENT/);
  });
});

describe('read-aloud', () => {
  it('reads a file part by part to the end', async () => {
    autoPage('');
    const p = file('story.txt', long);
    expect(await request({ kind: 'tts', who: 'session', file: p })).toBe('Read to the end (part 3 of 3).');
    const parts = sent.flatMap((m) => (m.type === 'request' ? [m.body] : []));
    expect(parts.map((b) => b.part)).toEqual([1, 2, 3]);
    for (const b of parts) expect((b.text ?? '').length).toBeLessThanOrEqual(1000);
  });

  it('strips markdown from a .md file', async () => {
    autoPage('');
    await request({ kind: 'tts', who: 'session', file: file('notes.md', '# Title\n\nSome **bold** words.') });
    const b = sent.find((m) => m.type === 'request');
    expect(b?.type === 'request' && b.body.text).toBe('Title\n\nSome bold words.');
  });

  it('starts at part N and reports a stop with where to resume', async () => {
    pageAct = (m) => {
      if (m.type === 'request') say({ type: 'stopped', part: m.body.part ?? 1 });
    };
    const r = await request({ kind: 'tts', who: 'session', file: file('s2.txt', long), part: 2 });
    expect(r).toBe(
      `${STOPPED} 2 He stopped it during part 2 of 3. To resume there, call tts with the same file and part=2.`,
    );
  });

  it('a part past the end is an error', async () => {
    await expect(request({ kind: 'tts', who: 'session', file: file('s3.txt', 'One.'), part: 5 })).rejects.toThrow(
      'part 5 is past the end: it has 1 parts',
    );
  });

  it('with listen, returns the heard turn and the end note', async () => {
    autoPage('thanks');
    const r = await request({ kind: 'tts', who: 'session', file: file('s4.txt', 'Short one.'), listen: true });
    expect(r).toMatch(TURN_PREFIX);
    expect(r).toMatch(/thanks\n\nRead to the end \(part 1 of 1\)\.$/);
  });

  it('a sentinel after the reading comes back exactly', async () => {
    pageAct = (m) => {
      if (m.type !== 'request') return;
      if (m.body.kind === 'tts') say({ type: 'complete', text: '', startAt: 0, endAt: 0 });
      else say({ type: 'nospeech' });
    };
    const r = await request({ kind: 'tts', who: 'session', file: file('s5.txt', 'Hi.'), listen: true, idleSec: 1 });
    expect(r).toBe(NO_SPEECH);
  });

  it('reads a url and refuses an HTML page', async () => {
    autoPage('');
    const server = (await import('node:http')).createServer((req, res) => {
      res.setHeader('content-type', req.url === '/page' ? 'text/html' : 'text/markdown');
      res.end('# Head\n\nBody text.');
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const addr = server.address();
    const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    expect(await request({ kind: 'tts', who: 'session', url: `${base}/a.md` })).toBe('Read to the end (part 1 of 1).');
    await expect(request({ kind: 'tts', who: 'session', url: `${base}/page` })).rejects.toThrow(/HTML page/);
    server.close();
  });
});
