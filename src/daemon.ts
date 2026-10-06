// The voice daemon: one hono app on 127.0.0.1 that holds one request slot, talks to the
// page over /ws, launches the Chrome --app window and runs Piper as a child process.

import { type ChildProcess, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createNodeWebSocket } from '@hono/node-ws';
import { launch } from 'chrome-launcher';
import { Hono } from 'hono';
import removeMarkdown from 'remove-markdown';
import { createActor } from 'xstate';
import { z } from 'zod';
import { createEngine } from './asr.js';
import {
  BACKGROUND_RESULT,
  BAD_MESSAGE_LOG,
  bargeLine,
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
  TURN_PREFIX,
} from './protocol.ts';
import { toParts } from './sentences.ts';
import { ackGate, type Heard, turnsMachine } from './turns.ts';

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
    chrome.process.on('exit', () => deps.log('window closed'));
  },
  exit(code: number): void {
    piper?.kill();
    deps.log(`daemon exit pid ${process.pid} code ${code}`);
    process.exit(code);
  },
  // Live update (spec 013): Claude Code's own plugin updater pulls a new version into its cache.
  update(): Promise<void> {
    return new Promise((done) => {
      const run = (args: string[], next: () => void): void => {
        const p = spawn('claude', args, { stdio: 'ignore', windowsHide: true, shell: true });
        const t = setTimeout(() => p.kill(), 120_000);
        p.on('error', () => {});
        p.on('close', () => {
          clearTimeout(t);
          next();
        });
      };
      run(['plugin', 'marketplace', 'update', 'stts-marketplace'], () =>
        run(['plugin', 'update', 'stts@stts-marketplace'], done),
      );
    });
  },
  // Hands the port, the window and the open listen to the newer install, then exits.
  handoff: (to: string): Promise<void> => handOver(to),
};

const same = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const INSTALLS = (): string =>
  process.env['STTS_INSTALLS'] ?? join(homedir(), '.claude', 'plugins', 'installed_plugins.json');

/** The dist folder of the installed stts plugin, or '' when there is none. */
export function installedDir(): string {
  try {
    const j = JSON.parse(readFileSync(INSTALLS(), 'utf8')) as {
      plugins?: Record<string, { installPath?: string }[]>;
    };
    const path = Object.entries(j.plugins ?? {}).find(([k]) => k.startsWith('stts@'))?.[1]?.[0]?.installPath;
    const d = path ? join(path, 'dist') : '';
    return d && existsSync(join(d, 'daemon.js')) ? d : '';
  } catch {
    return '';
  }
}

/** True when this daemon is the installed plugin: it never yields to an older client's shutdown. */
export const isLatest = (): boolean => {
  const d = installedDir();
  return d !== '' && same(d, here);
};

/**
 * Between turns, move to a newer install. Only while a plain listen with no words held is open:
 * the agent is blocked on it, so it makes no new call while the port changes hands (a new call
 * then made its client start an older daemon), and the listen is forwarded to the new daemon.
 */
// A tts with listen counts once its speech has played (the page said `listening`): it is then
// forwarded as a plain listen. Most listens are tts with listen, so stt alone rarely came up.
const safe = (): boolean =>
  !!slot && (slot.body.kind === 'stt' || (isListen(slot.body) && !!slot.listening)) && !carry && !held;

let httpServer: { close: () => void } | null = null;
let closePage: (() => void) | null = null;

/**
 * The hand-off with no gap a client can fall into. Stop taking new connections, start the new
 * daemon, wait until it answers, move the window to it, then forward the open listen to it and
 * pass its reply back on the connection the agent is already waiting on. Exiting first made the
 * agent's client respawn its own older daemon, which won the port and handed off again every
 * minute (log 2026-10-06 22:53 and 23:07 UTC).
 */
async function handOver(to: string): Promise<void> {
  deps.log(`live update: handing off to ${to}`);
  httpServer?.close();
  spawn(process.execPath, [join(to, 'daemon.js')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, STTS_ADOPT: '1' },
  }).unref();
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
    if (r?.ok && same(r.headers.get('X-Stts-Dir') ?? '', to)) break;
  }
  closePage?.();
  const s = slot;
  if (s) {
    clearTimeout(s.timer);
    const r = await fetch(`http://127.0.0.1:${port}/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        s.body.kind === 'stt'
          ? s.body
          : { kind: 'stt', who: s.body.who, ...(s.body.idleSec === undefined ? {} : { idleSec: s.body.idleSec }) },
      ),
    }).catch(() => null);
    const text = r ? await r.text() : NO_SPEECH;
    s.done({ status: r?.status === 504 ? 504 : 200, text });
    await sleep(200);
  }
  deps.exit(0);
}

// End conversation, remembered across daemons (a hand-off or a respawn starts a new process)
// until one reply carries it. Only the End button sets it (Mark 2026-10-07); a closed window never does.
const endedFile = (): string => join(dataDir, 'ended');
export const ended = (): boolean => existsSync(endedFile());
// Reads and clears: an End reaches exactly one reply, so a stale press never ends a later session
// (2026-10-07: a press from the day before ended the next session's first stt).
export function takeEnded(): boolean {
  const on = ended();
  if (on) setEnded(false);
  return on;
}
export function setEnded(on: boolean): void {
  mkdirSync(dataDir, { recursive: true });
  if (on) writeFileSync(endedFile(), new Date().toISOString());
  else rmSync(endedFile(), { force: true });
}

export async function liveUpdate(skipUpdate = false): Promise<boolean> {
  if (!safe()) return false;
  if (!skipUpdate && process.env['STTS_LIVE_UPDATE'] !== 'check') await deps.update();
  const to = installedDir();
  if (!to || same(to, here) || !safe()) return false;
  if (!newer(to)) {
    deps.log(`live update: refused a downgrade to ${to}`);
    return false;
  }
  await deps.handoff(to);
  return true;
}

type Reply = { status: 200 | 504; text: string };
type Slot = {
  id: number;
  body: RequestBody;
  timer: ReturnType<typeof setTimeout>;
  done: (r: Reply) => void;
  // The page already got this request (its speech may already have played).
  sent?: boolean;
  // The page reported its speech done and the listen open.
  listening?: boolean;
};

let slot: Slot | null = null;
let seq = 0; // request generation, not a turn id: turn ids come from turnsMachine
let carry = '';
let keepCarry = false; // speech after a timeout release belongs to the next listen
let page: ((m: DaemonMessage) => void) | null = null;
let windowOpening = false;
let windowTimer: ReturnType<typeof setTimeout> | undefined;
// An adopted daemon (a live update) starts with the window still open on its way back.
const adopted = process.env['STTS_ADOPT'] === '1';
const PAGE_GRACE_MS = 8000;
let pageGoneAt = Date.now();
let graceTimer: ReturnType<typeof setTimeout> | undefined;
/** Chrome started but no page connected in this long: clear the flag so the next send relaunches. */
export const WINDOW_OPEN_MS = 15000;
let held: Heard | null = null; // a typed message sent while no listen was open, for the next listen
let barge: string | null = null; // the cut-off line for a turn that interrupted the agent's speech
let typedNext = false; // the next finished turn was typed, for the "page typed turn N" log line

// Turn ids, dedupe, join and the ack gate live in the turns machine.
let turns = createActor(turnsMachine, { input: {} }).start();
let reported = 0;
function watchTurns(): void {
  turns.subscribe((s) => {
    const c = s.context;
    if (c.id <= reported) return;
    reported = c.id;
    if (typedNext) deps.log(`page typed turn ${c.id}`);
    typedNext = false;
    const line = barge;
    barge = null;
    if (slot && (isListen(slot.body) || line) && c.reply) settle(200, line ? `${c.reply}\n${line}` : c.reply);
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
  held = null;
  barge = null;
  typedNext = false;
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
  if (takeEnded()) {
    settle(200, CONVERSATION_ENDED);
    return;
  }
  if (page) {
    // Never replay: a tts the page already got is not spoken again after a reload or reconnect
    // (Mark 2026-10-06 heard an earlier reply twice). A tts with listen resends only its listen;
    // a plain tts is done.
    if (slot.sent && slot.body.kind === 'tts') {
      if (!isListen(slot.body)) {
        settle(200, readNotes.spoken);
        return;
      }
      const b = slot.body;
      page({
        type: 'request',
        id: slot.id,
        body: { kind: 'stt', who: b.who, ...(b.idleSec === undefined ? {} : { idleSec: b.idleSec }) },
      });
      return;
    }
    slot.sent = true;
    page({ type: 'request', id: slot.id, body: slot.body });
  } else if (adopted && Date.now() - pageGoneAt < PAGE_GRACE_MS) {
    // The window is reloading or reconnecting after a live update: its "ready" resends the
    // slot. Opening a second window here was the old behaviour.
    clearTimeout(graceTimer);
    graceTimer = setTimeout(send, PAGE_GRACE_MS);
  } else if (!windowOpening) {
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
  if (held && isListen(body)) {
    const h = held;
    held = null;
    hear(h, true);
  }
  if (slot?.id === id) send();
  return result;
}

// Words for the turns machine. A turn that finishes at once settles the slot inside this call.
function hear(h: Heard, typed: boolean): void {
  const text = `${carry} ${h.text}`.trim();
  carry = '';
  keepCarry = false;
  typedNext = typed;
  turns.send({ type: 'heard', text, startAt: h.startAt, endAt: h.endAt, typed });
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
    if (page !== sendToPage) return;
    page = null;
    pageGoneAt = Date.now();
    // An adopted daemon holds no Chrome handle: the window closing shows as the page not coming back.
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
      // Unmute: the page lost track of an open listen; resend only a listen, never a tts (a replay).
      case 'listening':
        if (slot) slot.listening = true;
        return;
      case 'relisten':
        if (slot && isListen(slot.body)) send();
        return;
      case 'log':
        deps.log(`page ${m.line}`);
        return;
      case 'settings':
        return;
      case 'complete': {
        const said = m.text.trim();
        const typed = m.source === 'typed';
        const h = { text: m.text, startAt: m.startAt, endAt: m.endAt };
        // A barge: his message cut the agent's speech off. The tts call returns it as the next turn.
        if (slot && m.interrupted && said) {
          barge = bargeLine(m.interrupted.part, m.interrupted.sentence);
          hear(h, typed);
          return;
        }
        if (!slot || !isListen(slot.body)) {
          // Typed with no listen open: held for the next listen, never dropped.
          if (typed && said) {
            held = h;
            deps.log('page typed held for the next listen');
            return;
          }
          // Speech with no listen open (after a Stop, a restart or a hand-off) is kept for the next
          // listen, never dropped (rule 43; Mark 2026-10-06: a stt returned only STOPPED and his words were gone).
          // Words while a speak-only tts is open are held too: they used to end that tts and vanish.
          if (!slot || said) {
            if (keepCarry) carry = `${carry} ${m.text}`.trim();
            else if (said) {
              held = held ? { ...held, text: `${held.text} ${said}`, endAt: m.endAt } : h;
              deps.log('page heard held for the next listen');
            }
            return;
          }
          // The stopped speech's own complete while a barge turn is still joining: not the end of the tts.
          if (barge) return;
          settle(200, readNotes.spoken);
          return;
        }
        // An empty complete is the page finishing a tts this listen superseded: not a turn.
        if (!said) return;
        hear(h, typed);
        // Joining, or dropped as a duplicate or stale: the listen stays open.
        if (slot) send();
        return;
      }
      case 'nospeech':
        turns.send({ type: 'nospeech' });
        settle(200, NO_SPEECH);
        return;
      case 'stopped':
        settle(200, takeEnded() ? CONVERSATION_ENDED : `${STOPPED} ${m.part}`);
        return;
      case 'cancel':
      case 'close':
        // Not an End (Mark 2026-10-07): only the End button ends. The call ends empty and the
        // next call reopens the window.
        settle(200, NO_SPEECH);
        return;
      case 'ended':
        // Written first so a press with no call open (mid-speech, between calls) is never lost;
        // an open call takes it at once. No exit: the newest daemon keeps the port (note above app).
        setEnded(true);
        if (slot && takeEnded()) settle(200, CONVERSATION_ENDED);
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

// The newest daemon never gives up the port (Mark 2026-10-06 10:04): an agent session keeps the
// MCP client it began with, and when no daemon answered that old client started its own, older
// daemon, so the window came back on an old build. A closed window or an End leaves it idle.
export const app = new Hono();
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

app.use('*', async (c, next) => {
  await next();
  c.header('X-Stts-Dir', here);
  if (isLatest()) c.header('X-Stts-Latest', '1');
});

app.get('/api/ping', (c) => c.text('ok'));

// Force a live update now instead of waiting for the 60 s check: pull the new version, then hand
// off at the first safe moment (checked every second for up to 5 minutes).
app.post('/api/update', async (c) => {
  if (process.env['STTS_LIVE_UPDATE'] !== 'check') await deps.update();
  const to = installedDir();
  if (!to || same(to, here) || !newer(to)) return c.text('up to date');
  void (async () => {
    for (let i = 0; i < 300; i++) {
      if (await liveUpdate(true)) return;
      await sleep(1000);
    }
    deps.log('live update: no safe moment within 5 minutes');
  })();
  return c.text(`updating to ${to}`);
});

app.post('/api/shutdown', (c) => {
  // An older client after a live update would retire the newer daemon; it uses this one instead.
  if (isLatest()) return c.text('newest install', 409);
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
  if (body.start) setEnded(false);
  else if (takeEnded()) return c.text(CONVERSATION_ENDED);

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
    // A barge turn ends the reading: the agent answers it, then carries on from the cut-off part.
    if (r.status !== 200 || r.text === CONVERSATION_ENDED || TURN_PREFIX.test(r.text)) return out(r);
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
  // A Piper that exits (its port still held by the old daemon's Piper during a live update) is
  // forgotten, so the next clip starts a fresh one: a dead handle failed every clip for 17 s and
  // the browser voice spoke instead (log 2026-10-05 23:49 UTC).
  const p = piper;
  p.on('exit', () => {
    if (piper === p) piper = null;
  });
}

// The Piper voices installed: every .onnx in the voices folder, by name, sorted.
app.get('/voice/list', async (c) => {
  const files = await readdir(join(PIPER_HOME, 'voices')).catch(() => [] as string[]);
  return c.json(
    files
      .filter((f) => f.endsWith('.onnx'))
      .map((f) => f.slice(0, -5))
      .sort(),
  );
});

// The page calls this on load: Piper loads its model while Mark speaks, not on the first
// reply (that cost 5.5 s, log 2026-10-05).
app.post('/voice/warm', async (c) => {
  const parsed = ClipBody.pick({ voice: true }).safeParse(await c.req.json().catch(() => null));
  if (parsed.success && !piper) startPiper(parsed.data.voice);
  return c.body(null, 204);
});

app.post('/voice/clip', async (c) => {
  const parsed = ClipBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    deps.log('piper clip refused: bad body or voice name');
    return c.text(parsed.error.message, 400);
  }
  const { text, voice, rate } = parsed.data;
  const t0 = Date.now();
  let r = await piperClip(text, voice, rate ?? 1);
  // Not up yet: start it, or wait for the one the warm-up started.
  if (!r) {
    if (!piper) startPiper(voice);
    for (let i = 0; i < 30 && !r; i++) {
      await sleep(500);
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
        closePage = () => ws.close();
      },
      onMessage: (e) => link?.onMessage(String(e.data)),
      onClose: () => link?.detach(),
    };
  }),
);

// Speech to text (spec 014): the page streams 16 kHz float audio here, the engine answers with
// speechstart and final text on the same socket.
app.get(
  '/asr',
  upgradeWebSocket(() => {
    let engine: ReturnType<typeof createEngine> | null = null;
    return {
      onOpen: (_e, ws) => {
        engine = createEngine(dataDir, (ev) => {
          if (ev.type === 'error') deps.log(`asr ${ev.error}`);
          ws.send(JSON.stringify(ev));
        });
      },
      onMessage: (e) => {
        const d = e.data;
        if (typeof d === 'string') return;
        const u8 = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array((d as Blob & Uint8Array).buffer);
        engine?.push(new Float32Array(u8.slice().buffer));
      },
    };
  }),
);

app.get('/earcon/:name', serveStatic({ root: join(here, 'earcon'), rewriteRequestPath: (p) => p.slice(8) }));
// The page itself is never cached (its assets are content-hashed): a reopened window showed an
// old layout from a cached index.html (2026-10-06).
app.get('/', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-cache');
});
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
  httpServer = server;
  // Adopted with no window coming back (closed during the hand-off): exit like a closed window.

  let tries = 0;
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EADDRINUSE') throw e;
    // Adopting: the old daemon is still exiting, so wait for the port (up to 10 s).
    if (adopted && tries++ < 50) {
      setTimeout(() => server.listen(p, '127.0.0.1'), 200);
      return;
    }
    void exitCodeWhenTaken(p).then((code) => process.exit(code));
  });
  if (process.env['STTS_LIVE_UPDATE'] !== '0') {
    let busy = false;
    setInterval(() => {
      if (busy) return;
      busy = true;
      void liveUpdate().finally(() => {
        busy = false;
      });
    }, LIVE_UPDATE_MS).unref();
  }
}

const LIVE_UPDATE_MS = Number(process.env['STTS_LIVE_UPDATE_MS'] ?? 60_000);

/** A daemon built after this one: never hand off or redirect to an older install. */
export function newer(dir: string): boolean {
  const at = (d: string): number => {
    try {
      return statSync(join(d, 'daemon.js')).mtimeMs;
    } catch {
      return Number.NaN;
    }
  };
  const theirs = at(dir);
  const ours = at(here);
  // Run from source (tests, a dev run): any built install is newer.
  return !Number.isNaN(theirs) && (Number.isNaN(ours) || theirs > ours);
}

/**
 * Every daemon start, whichever client started it: update the plugin first, then run the newest
 * installed daemon instead of this one. An agent session keeps its MCP client from when it began,
 * and that client started its own, older daemon, so the window showed old layout and old behaviour
 * until a live update a minute later (Mark, 2026-10-06 09:23).
 */
export async function boot(): Promise<void> {
  if (!adopted && process.env['STTS_LIVE_UPDATE'] !== '0') {
    if (process.env['STTS_LIVE_UPDATE'] !== 'check') await Promise.race([deps.update(), sleep(30_000)]);
    const to = installedDir();
    if (to && !same(to, here)) {
      if (newer(to)) {
        deps.log(`daemon start redirected to the newest install ${to}`);
        spawn(process.execPath, [join(to, 'daemon.js')], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        }).unref();
        process.exit(0);
      }
      deps.log(`live update: refused a downgrade to ${to}`);
    }
  }
  start();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void boot();
