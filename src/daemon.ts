// The voice daemon: one hono app on 127.0.0.1 that holds one request slot, talks to the
// page over /ws, launches the Chrome --app window and runs Piper as a child process.
import { type ChildProcess, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createNodeWebSocket } from '@hono/node-ws';
import { launch } from 'chrome-launcher';
import { Hono } from 'hono';
import {
  BACKGROUND_RESULT,
  BAD_MESSAGE_LOG,
  CONVERSATION_ENDED,
  type DaemonMessage,
  DEFAULT_PORT,
  LISTEN_CONTINUES,
  NO_SPEECH,
  PageMessage,
  parseMessage,
  REQUEST_TIMEOUT_MS,
  RequestBody,
  readNotes,
  STOPPED,
  SUPERSEDED,
  turnReply,
} from './protocol.ts';

export const port = Number(process.env['STTS_PORT'] ?? DEFAULT_PORT);
const budgetMs = () => Number(process.env['STTS_REQUEST_TIMEOUT_MS'] ?? REQUEST_TIMEOUT_MS);
const here = dirname(fileURLToPath(import.meta.url));
export const dataDir =
  process.platform === 'win32'
    ? join(process.env['LOCALAPPDATA'] ?? homedir(), 'cc-gc-stts')
    : join(homedir(), '.local', 'share', 'cc-gc-stts');
const profileDir = join(dataDir, port === DEFAULT_PORT ? 'profile' : `profile-${port}`);
const PIPER_PORT = 15987;

// Swappable side effects, so the tests run with no Chrome, no Piper and no exit.
export const deps = {
  log(line: string): void {
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(join(dataDir, 'daemon.log'), `${new Date().toISOString()} ${line}\n`);
  },
  async openWindow(): Promise<void> {
    const chrome = await launch({
      chromeFlags: [`--app=http://127.0.0.1:${port}/`, '--window-size=1600,600'],
      userDataDir: profileDir,
    });
    chrome.process.on('exit', () => deps.exit(0));
  },
  exit(code: number): void {
    piper?.kill();
    deps.log(`daemon exit pid ${process.pid} code ${code}`);
    process.exit(code);
  },
};

type Slot = {
  id: number;
  body: RequestBody;
  ac: AbortController;
  timer: ReturnType<typeof setTimeout>;
  done: (status: 200 | 504, text: string) => void;
};

let slot: Slot | null = null;
let nextId = 0;
let turn = 0;
let carry = '';
let keepCarry = false; // speech after a timeout release belongs to the next listen
let page: ((m: DaemonMessage) => void) | null = null;
let windowOpening = false;

export const slotId = (): number | null => slot?.id ?? null;
const isListen = (b: RequestBody): boolean => b.kind === 'stt' || b.listen === true;

function settle(status: 200 | 504, text: string): void {
  const s = slot;
  if (!s) return;
  slot = null;
  clearTimeout(s.timer);
  s.done(status, text);
}

function release(reason: 'superseded' | 'timeout' | 'background'): void {
  if (slot && isListen(slot.body)) page?.({ type: 'released', reason });
}

function send(): void {
  if (!slot) return;
  if (page) page({ type: 'request', id: slot.id, body: slot.body });
  else if (!windowOpening) {
    windowOpening = true;
    deps.openWindow().catch((e: unknown) => {
      windowOpening = false;
      deps.log(`chrome launch failed ${String(e)}`);
    });
  }
}

// The page side of /ws. Returns the frame handler; the caller wires close to detach().
export function attachPage(sendToPage: (m: DaemonMessage) => void): {
  onMessage: (raw: string) => void;
  detach: () => void;
} {
  page = sendToPage;
  windowOpening = false;
  const detach = (): void => {
    if (page === sendToPage) page = null;
  };
  const onMessage = (raw: string): void => {
    const m = parseMessage(PageMessage, raw);
    if (!m) {
      deps.log(BAD_MESSAGE_LOG);
      return;
    }
    switch (m.type) {
      case 'ready':
        send();
        return;
      case 'log':
        deps.log(`page ${m.line}`);
        return;
      case 'settings':
        return;
      case 'complete': {
        if (!slot) {
          if (keepCarry) carry = `${carry} ${m.text}`.trim();
          return; // spec 042: speech with no open listen is dropped
        }
        if (!isListen(slot.body)) {
          settle(200, readNotes.spoken);
          return;
        }
        const text = `${carry} ${m.text}`.trim();
        carry = '';
        keepCarry = false;
        turn += 1;
        settle(200, turnReply(turn, text, m.startAt, m.endAt));
        return;
      }
      case 'nospeech':
        settle(200, NO_SPEECH);
        return;
      case 'stopped':
        settle(200, `${STOPPED} ${m.part}`);
        return;
      case 'cancel':
      case 'close':
      case 'ended':
        settle(200, CONVERSATION_ENDED);
        if (m.type !== 'cancel') deps.exit(0);
        return;
    }
  };
  return { onMessage, detach };
}

export const app = new Hono();
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

app.use('*', async (c, next) => {
  await next();
  c.header('X-Stts-Dir', here);
});

app.get('/api/ping', (c) => c.text('ok'));

app.post('/api/shutdown', (c) => {
  setTimeout(() => deps.exit(0), 50);
  return c.text('ok');
});

app.get('/barge', (c) => c.json({ text: '', open: page !== null }));

app.post('/notify', (c) => {
  if (slot && isListen(slot.body)) {
    release('background');
    settle(200, BACKGROUND_RESULT);
  }
  return c.text('ok');
});

app.post('/request', async (c) => {
  const parsed = RequestBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.text(parsed.error.message, 400);
  const body = parsed.data;
  if (body.who === 'agent' && body.close) body.close = false; // spec 026: only the session closes

  if (slot) {
    release('superseded');
    slot.ac.abort();
    settle(504, SUPERSEDED);
  }
  if (isListen(body)) keepCarry = false;

  const id = ++nextId;
  const ac = new AbortController();
  const result = new Promise<{ status: 200 | 504; text: string }>((resolve) => {
    const timer = setTimeout(() => {
      if (slot?.id !== id) return;
      if (isListen(body)) {
        release('timeout');
        keepCarry = true;
        settle(200, LISTEN_CONTINUES);
      } else settle(200, readNotes.spoken);
    }, budgetMs());
    slot = { id, body, ac, timer, done: (status, text) => resolve({ status, text }) };
  });
  send();
  const { status, text } = await result;
  return c.text(text, status);
});

// Piper: one child process, started on the first clip, proxied so the page needs one origin.
let piper: ChildProcess | null = null;
app.post('/voice/clip', async (c) => {
  const { text, voice, rate } = (await c.req.json()) as { text: string; voice: string; rate?: number };
  piper ??= spawn(
    'python',
    ['-m', 'piper.http_server', '--host', '127.0.0.1', '--port', String(PIPER_PORT), '-m', voice],
    {
      cwd: join(dataDir, 'piper', 'voices'),
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${PIPER_PORT}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice, length_scale: 1 / (rate ?? 1) }),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  const wav = r?.ok ? await r.arrayBuffer() : null;
  // ponytail: logs the first 30 chars, as the old line did; never the full text.
  const head = JSON.stringify(text.slice(0, 30));
  if (!wav) {
    deps.log(`piper clip failed ${voice} ${Date.now() - t0}ms ${head}`);
    return c.text('piper failed', 502);
  }
  deps.log(`piper clip ok ${voice} ${wav.byteLength}B ${Date.now() - t0}ms ${head}`);
  return c.body(wav, 200, { 'content-type': 'audio/wav' });
});

app.get(
  '/ws',
  upgradeWebSocket(() => {
    let link: ReturnType<typeof attachPage> | null = null;
    return {
      onOpen: (_e, ws) => {
        link = attachPage((m) => ws.send(JSON.stringify(m)));
      },
      onMessage: (e) => link?.onMessage(String(e.data)),
      onClose: () => link?.detach(),
    };
  }),
);

app.get('/earcon/:name', serveStatic({ root: join(here, 'earcon'), rewriteRequestPath: (p) => p.slice(8) }));
app.get('/*', serveStatic({ root: join(here, 'web') }));

// Binding the port is the single-instance lock. On EADDRINUSE: a live daemon answers ok -> 0.
export async function exitCodeWhenTaken(p: number): Promise<0 | 1> {
  const r = await fetch(`http://127.0.0.1:${p}/api/ping`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
  return r?.ok && (await r.text()) === 'ok' ? 0 : 1;
}

export function start(p: number = port): void {
  const server = serve({ fetch: app.fetch, port: p, hostname: '127.0.0.1' }, () =>
    deps.log(`daemon start pid ${process.pid}`),
  );
  injectWebSocket(server as Parameters<typeof injectWebSocket>[0]);
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EADDRINUSE') throw e;
    void exitCodeWhenTaken(p).then((code) => process.exit(code));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) start();
