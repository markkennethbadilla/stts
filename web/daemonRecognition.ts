// The page's recogniser (spec 014): the echo-cancelled mic stream goes to the daemon over /asr as
// 16 kHz audio, and the daemon's sherpa-onnx engine sends back speechstart and final text. It has
// the shape of Chrome's SpeechRecognition, so the page machine is unchanged. The audio pipe lives
// for the page, not for one recogniser: a restart never stops the audio, and text that lands
// while no recogniser is started waits for the next one. Nothing he says is dropped, except while
// muted (spec 005, Mark 2026-10-18): muted audio never leaves the page. At mute the daemon flushes
// the audio already sent, and those finals go back as his words from before the mute; the socket
// then closes. Before this, muted speech reached the daemon and replayed at unmute (19:30:59), and
// then speech just before a mute was thrown away with it.

import workletSrc from './pcm-worklet.js?raw';

const workletUrl = URL.createObjectURL(new Blob([workletSrc], { type: 'text/javascript' }));

type AsrEvent =
  | { type: 'speechstart' }
  | { type: 'final'; text: string }
  | { type: 'error'; error: string }
  | { type: 'flushed' };
type Result = ArrayLike<{ transcript: string }> & { isFinal: boolean };

let active: DaemonRecognition | null = null;
const backlog: AsrEvent[] = [];
let fed: MediaStream | null = null;
let sock: WebSocket | null = null;
// Audio captured while the socket is down is sent when it reconnects.
const unsent: Float32Array<ArrayBuffer>[] = [];
let muted = false;
let ctx: AudioContext | null = null;
// Mic frames that reached the page, for the unmute stall check below.
let frames = 0;
let log: (line: string) => void = () => {};
/** Where this module's diagnostics go (the daemon log, through the page). */
export function setAsrLog(f: (line: string) => void): void {
  log = f;
}

// After an unmute the mic must be sending and the socket open within this long, or the pipe is
// rebuilt (Mark 2026-10-18 21:28 and 21:34: unmuted, spoke, nothing registered until a second unmute).
export const UNMUTE_CHECK_MS = 2500;

// Longest wait for the daemon to decode the utterance cut off by a mute.
export const FLUSH_GRACE_MS = 1500;

/**
 * Mute gate. Muted, no audio leaves the page. The audio already sent is flushed: the daemon decodes
 * the utterance in flight, and every final from before the mute (the backlog too) goes to `onFlushed`
 * once, within FLUSH_GRACE_MS. Then the socket closes; nothing from it reaches a later recogniser.
 */
export function setMuted(m: boolean, onFlushed?: (finals: string[]) => void, onStall?: (why: string) => void): void {
  muted = m;
  if (!m) {
    unmuted(onStall);
    return;
  }
  const finals = backlog.flatMap((e) => (e.type === 'final' ? [e.text] : []));
  backlog.length = 0;
  const s = sock;
  sock = null;
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    s?.close();
    onFlushed?.(finals);
  };
  const timer = setTimeout(finish, FLUSH_GRACE_MS);
  if (s?.readyState !== WebSocket.OPEN) {
    unsent.length = 0;
    finish();
    return;
  }
  for (const f of unsent.splice(0)) s.send(f);
  s.onmessage = (e) => {
    const ev = JSON.parse(String(e.data)) as AsrEvent;
    if (ev.type === 'final') finals.push(ev.text);
    else if (ev.type === 'flushed') finish();
  };
  s.send('flush');
}

/**
 * Unmute: a fresh socket opens now, not on the first frame, and frames wait in `unsent` until it is
 * open; the audio context is resumed. If no frame or no open socket follows within UNMUTE_CHECK_MS,
 * the socket is rebuilt and `onStall` reopens the mic, so speech right after an unmute is never lost.
 */
function unmuted(onStall?: (why: string) => void): void {
  const at = Date.now();
  const seen = frames;
  if (!sock || sock.readyState > WebSocket.OPEN) connect();
  if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => {});
  setTimeout(() => {
    if (muted) return;
    const open = sock?.readyState === WebSocket.OPEN;
    const audio = frames > seen;
    if (open && audio) return;
    const why = `asr unmute stall after ${Date.now() - at}ms:${audio ? '' : ' no mic audio'}${open ? '' : ' socket not open'}`;
    log(why);
    if (!open) {
      const old = sock;
      sock = null;
      old?.close();
      connect();
    }
    if (!audio) onStall?.(why);
  }, UNMUTE_CHECK_MS);
}

function connect(): void {
  const s = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/asr`);
  s.binaryType = 'arraybuffer';
  const at = Date.now();
  s.onopen = () => {
    log(`asr socket open in ${Date.now() - at}ms, ${unsent.length} frames waiting`);
    for (const f of unsent.splice(0)) s.send(f);
  };
  s.onmessage = (e) => {
    // A socket from before mute, or text while muted, is never his turn.
    if (sock !== s || muted) return;
    const ev = JSON.parse(String(e.data)) as AsrEvent;
    if (active) active.handle(ev);
    else backlog.push(ev);
  };
  s.onclose = () => {
    if (sock === s) log('asr socket closed, reconnecting');
    if (sock === s) setTimeout(connect, 500);
  };
  sock = s;
}

/** Streams this mic to the daemon; a new stream replaces the old one, the same one is a no-op. */
export async function feed(stream: MediaStream): Promise<void> {
  if (fed === stream) return;
  fed = stream;
  if (!sock) connect();
  const c = new AudioContext({ sampleRate: 16000 });
  ctx = c;
  await c.audioWorklet.addModule(workletUrl);
  const node = new AudioWorkletNode(c, 'pcm');
  node.port.onmessage = (e: MessageEvent<Float32Array<ArrayBuffer>>) => {
    if (fed !== stream || muted) return;
    frames++;
    // A socket closed under us is replaced; its frames wait in `unsent` for the new one.
    if (!sock || sock.readyState > WebSocket.OPEN) connect();
    if (sock?.readyState === WebSocket.OPEN) sock.send(e.data);
    else unsent.push(e.data);
  };
  c.createMediaStreamSource(stream).connect(node);
}

export class DaemonRecognition {
  continuous = true;
  interimResults = true;
  processLocally?: boolean;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error?: string }) => void) | null = null;
  onspeechstart: (() => void) | null = null;
  onspeechend: (() => void) | null = null;
  onaudiostart: (() => void) | null = null;
  onresult: ((e: { resultIndex: number; results: ArrayLike<Result> }) => void) | null = null;
  private results: Result[] = [];

  start(_track?: MediaStreamTrack): void {
    active = this;
    queueMicrotask(() => {
      if (active !== this) return;
      this.onstart?.();
      this.onaudiostart?.();
      for (const e of backlog.splice(0)) this.handle(e);
    });
  }
  stop(): void {
    this.abort();
  }
  abort(): void {
    if (active === this) active = null;
    queueMicrotask(() => this.onend?.());
  }
  handle(e: AsrEvent): void {
    if (e.type === 'speechstart') this.onspeechstart?.();
    else if (e.type === 'error') this.onerror?.({ error: e.error });
    else if (e.type === 'final') {
      this.results.push(Object.assign([{ transcript: e.text }], { isFinal: true }));
      this.onresult?.({ resultIndex: this.results.length - 1, results: this.results });
      this.onspeechend?.();
    }
  }
}
