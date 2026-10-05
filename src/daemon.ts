// The voice daemon: one hono app on 127.0.0.1 that holds one request slot, talks to the
// page over /ws, launches the Chrome --app window and runs Piper as a child process.
import { type ChildProcess, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createNodeWebSocket } from '@hono/node-ws';
import { launch } from 'chrome-launcher';
import { Hono } from 'hono';
import removeMarkdown from 'remove-markdown';
import { createActor } from 'xstate';
import { z } from 'zod';
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
  SENTINELS,
  STOPPED,
  SUPERSEDED,
} from './protocol.ts';
import { toParts } from './sentences.ts';
import { ackGate, turnsMachine } from './turns.ts';

export const port = Number(process.env['STTS_PORT'] ?? DEFAULT_PORT);
const budgetMs = () => Number(process.env['STTS_REQUEST_TIMEOUT_MS'] ?? REQUEST_TIMEOUT_MS);
const here = dirname(fileURLToPath(import.meta.url));
export const dataDir =
  process.platform === 'win32'
    ? join(process.env['LOCALAPPDATA'] ?? homedir(), 'cc-gc-stts')
    : join(homedir(), '.local', 'share', 'cc-gc-stts');
const profileDir =
  process.env['STTS_PROFILE_DIR'] ?? join(dataDir, port === DEFAULT_PORT ? 'profile' : `profile-${port}`);
const PIPER_PORT = Number(process.env['STTS_PIPER_PORT'] ?? 15987);
const PIPER_HOME = process.env['STTS_PIPER_HOME'] ?? join(dataDir, 'piper');

// Swappable side effects, so the tests run with no Chrome, no Piper and no exit.
export const deps = {
  log(line: string): void {
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(join(dataDir, 'daemon.log'), `${new Date().toISOString()} ${line}\n`);
  },
  async openWindow(): Promise<void> {
    mkdirSync(profileDir, { recursive: true }); // chrome-launcher writes chrome.pid into it
    const chrome = await launch({
      // The old install's flags (spec 039): chrome-launcher's defaults (muted audio among them) are off.
      // A fixed debugging port: with port 0, chrome-launcher reads the port from chrome-err.log,
      // which this kept profile appends to, so it found a stale port from an earlier run.
      port: port + 100,
      startingUrl: 'about:blank',
      ignoreDefaultFlags: true,
      chromeFlags: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-infobars',
        '--test-type',
        '--disable-blink-features=AutomationControlled',
        `--app=http://127.0.0.1:${port}/`,
        '--window-size=1600,600',
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-ui-for-media-stream',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
      userDataDir: profileDir,
    });
    // chrome-launcher can hand back no process (Chrome handed off to a running instance).
    if (!chrome?.process) throw new Error('no chrome process');
    chrome.process.on('exit', () => deps.exit(0));
  },
  exit(code: number): void {
    piper?.kill();
    deps.log(`daemon exit pid ${process.pid} code ${code}`);
    process.exit(code);
  },
};

type Reply = { status: 200 | 504; text: string };
type Slot = { id: number; body: RequestBody; timer: ReturnType<typeof setTimeout>; done: (r: Reply) => void };

let slot: Slot | null = null;
let seq = 0; // request generation, not a turn id: turn ids come from turnsMachine
let carry = '';
let keepCarry = false; // speech after a timeout release belongs to the next listen
let page: ((m: DaemonMessage) => void) | null = null;
let windowOpening = false;
let windowTimer: ReturnType<typeof setTimeout> | undefined;
/** Chrome started but no page connected in this long: clear the flag so the next send relaunches. */
export const WINDOW_OPEN_MS = 15000;

// Turn ids, dedupe, join and the ack gate live in the turns machine.
let turns = createActor(turnsMachine, { input: {} }).start();
let reported = 0;
function watchTurns(): void {
  turns.subscribe((s) => {
    const c = s.context;
    if (c.id <= reported) return;
    reported = c.id;
    if (slot && isListen(slot.body) && c.reply) settle(200, c.reply);
    else {
      // The listen went away while joining: keep the words for the next one.
      carry = `${carry} ${c.last?.text ?? ''}`.trim();
      turns.send({ type: 'answered' });
    }
  });
}
watchTurns();

/** Tests only: a fresh turns machine and no carry. */
export function resetTurns(): void {
  turns.stop();
  turns = createActor(turnsMachine, { input: {} }).start();
  reported = 0;
  carry = '';
  keepCarry = false;
  watchTurns();
}

export const slotId = (): number | null => slot?.id ?? null;
const isListen = (b: RequestBody): boolean => b.kind === 'stt' || b.listen === true;

function settle(status: 200 | 504, text: string): void {
  const s = slot;
  if (!s) return;
  slot = null;
  clearTimeout(s.timer);
  s.done({ status, text });
}

function release(reason: 'superseded' | 'timeout' | 'background'): void {
  if (slot && isListen(slot.body)) page?.({ type: 'released', reason });
}

function send(): void {
  if (!slot) return;
  if (page) page({ type: 'request', id: slot.id, body: slot.body });
  else if (!windowOpening) {
    windowOpening = true;
    clearTimeout(windowTimer);
    windowTimer = setTimeout(() => {
      if (!windowOpening) return;
      windowOpening = false;
      deps.log('window open timed out');
    }, WINDOW_OPEN_MS);
    // Promise.resolve().then: a synchronous throw lands in the same catch, never out of send.
    Promise.resolve()
      .then(() => deps.openWindow())
      .catch((e: unknown) => {
        windowOpening = false;
        clearTimeout(windowTimer);
        deps.log(`chrome launch failed ${e instanceof Error ? e.message : String(e)}`);
      });
  }
}

// One page round trip in the slot, bounded by ms.
function occupy(id: number, body: RequestBody, ms: number): Promise<Reply> {
  if (isListen(body)) keepCarry = false;
  const result = new Promise<Reply>((resolve) => {
    const timer = setTimeout(
      () => {
        if (slot?.id !== id) return;
        if (isListen(body)) {
          release('timeout');
          keepCarry = true;
          turns.send({ type: 'continues' });
          settle(200, LISTEN_CONTINUES);
        } else settle(200, readNotes.spoken);
      },
      Math.max(0, ms),
    );
    slot = { id, body, timer, done: resolve };
  });
  send();
  return result;
}

// The page side of /ws. Returns the frame handler; the caller wires close to detach().
export function attachPage(sendToPage: (m: DaemonMessage) => void): {
  onMessage: (raw: string) => void;
  detach: () => void;
} {
  page = sendToPage;
  windowOpening = false;
  clearTimeout(windowTimer);
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
        // An empty complete is the page finishing a tts this listen superseded: not a turn.
        if (!m.text.trim()) return;
        const text = `${carry} ${m.text}`.trim();
        carry = '';
        keepCarry = false;
        turns.send({ type: 'heard', text, startAt: m.startAt, endAt: m.endAt });
        // Joining, or dropped as a duplicate or stale: the listen stays open.
        if (slot) send();
        return;
      }
      case 'nospeech':
        turns.send({ type: 'nospeech' });
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

// Read-aloud content by reference. Markdown is stripped; plain text is left as it is,
// because remove-markdown would eat a line that starts with "1." or "-". HTML is refused.
export async function loadText(file?: string, url?: string): Promise<string> {
  if (file) {
    const raw = await readFile(file, 'utf-8');
    return /\.(md|markdown|mdx)$/i.test(file) ? removeMarkdown(raw) : raw;
  }
  if (!url) throw new Error('pass text, file or url');
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`fetching ${url} returned ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (/html/i.test(type)) {
    throw new Error(
      `${url} is an HTML page, which would be read out as markup. Save its text to a file and pass file instead.`,
    );
  }
  const raw = await res.text();
  return /markdown/i.test(type) || /\.(md|markdown)(\?|#|$)/i.test(url) ? removeMarkdown(raw) : raw;
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
    turns.send({ type: 'background' });
    settle(200, BACKGROUND_RESULT);
  }
  return c.text('ok');
});

app.post('/request', async (c) => {
  const parsed = RequestBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.text(parsed.error.message, 400);
  const body = parsed.data;
  if (body.who === 'agent' && body.close) body.close = false; // spec 026: only the session closes

  const t = turns.getSnapshot().context;
  if (body.kind === 'stt') {
    const refused = ackGate(t, body.ack);
    if (refused) return c.text(refused, 409);
  }
  if (body.kind === 'tts' || body.ack === t.id) turns.send({ type: 'answered' });

  const byRef = body.kind === 'tts' && body.text === undefined;
  let parts: string[] = [];
  if (byRef) {
    try {
      parts = toParts(await loadText(body.file, body.url));
    } catch (e) {
      return c.text(e instanceof Error ? e.message : String(e), 400);
    }
    if (!parts.length) return c.text('there is nothing to read in it', 400);
    if ((body.part ?? 1) > parts.length) {
      return c.text(`part ${body.part} is past the end: it has ${parts.length} parts`, 400);
    }
  }

  if (slot) {
    release('superseded');
    settle(504, SUPERSEDED);
  }
  const id = ++seq;
  const t0 = Date.now();
  const left = (): number => budgetMs() - (Date.now() - t0);
  const out = (r: Reply) => c.text(r.text, r.status);

  if (!byRef) return out(await occupy(id, body, budgetMs()));

  // Read-aloud: part by part, no new part after half the budget, then the listen.
  const n = parts.length;
  const where = body.file ? 'the same file' : 'the same url';
  const first = (body.part ?? 1) - 1;
  let i = first;
  for (; i < n; i++) {
    if (i > first && Date.now() - t0 > budgetMs() / 2) break;
    if (seq !== id) return c.text(SUPERSEDED, 504);
    const last = i === n - 1;
    const partBody: RequestBody = {
      kind: 'tts',
      who: body.who,
      text: parts[i] ?? '',
      part: i + 1,
      listen: false,
      close: body.close === true && body.listen !== true && last,
      ...(body.rate === undefined ? {} : { rate: body.rate }),
      ...(body.volume === undefined ? {} : { volume: body.volume }),
    };
    const r = await occupy(id, partBody, left());
    if (r.status !== 200 || r.text === CONVERSATION_ENDED) return out(r);
    if (r.text.startsWith(STOPPED)) return c.text(`${r.text} ${readNotes.stopped(i + 1, n, where)}`);
  }
  if (i < n) return c.text(readNotes.outOfTime(first + 1, i, n, where));
  const note = readNotes.end(n);
  if (body.listen !== true) return c.text(note);
  if (seq !== id) return c.text(SUPERSEDED, 504);
  const heard = await occupy(
    id,
    { kind: 'stt', who: body.who, ...(body.idleSec === undefined ? {} : { idleSec: body.idleSec }) },
    left(),
  );
  if (heard.status !== 200 || (SENTINELS as readonly string[]).includes(heard.text)) return out(heard);
  return c.text(`${heard.text}\n\n${note}`);
});

// Piper: its own HTTP server, started on the first clip if nothing answers on its port,
// proxied so the page needs one origin. The page calls POST /voice/clip {text, voice, rate}.
let piper: ChildProcess | null = null;
// voice becomes a file name for Piper: no path separators.
const ClipBody = z.object({
  text: z.string(),
  voice: z.string().regex(/^[\w.-]+$/),
  rate: z.number().min(0.5).max(2).optional(),
});
const piperClip = (text: string, voice: string, rate: number) =>
  fetch(`http://127.0.0.1:${PIPER_PORT}/synthesize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice, length_scale: 1 / rate }),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);

function startPiper(voice: string): void {
  const voices = join(PIPER_HOME, 'voices');
  const py = join(PIPER_HOME, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const args = ['-m', 'piper.http_server', '--host', '127.0.0.1', '--port', String(PIPER_PORT)];
  piper = spawn(py, [...args, '-m', join(voices, `${voice}.onnx`), '--data-dir', voices, '--sentence-silence', '0.2'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  piper.on('error', (e) => deps.log(`piper start failed ${String(e)}`));
}

app.post('/voice/clip', async (c) => {
  const parsed = ClipBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.text(parsed.error.message, 400);
  const { text, voice, rate } = parsed.data;
  const t0 = Date.now();
  let r = await piperClip(text, voice, rate ?? 1);
  if (!r && !piper) {
    startPiper(voice);
    for (let i = 0; i < 30 && !r; i++) {
      await new Promise((ok) => setTimeout(ok, 500));
      r = await piperClip(text, voice, rate ?? 1);
    }
  }
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
