// The page's recogniser (spec 014): the echo-cancelled mic stream goes to the daemon over /asr as
// 16 kHz audio, and the daemon's sherpa-onnx engine sends back speechstart and final text. It has
// the shape of Chrome's SpeechRecognition, so the page machine is unchanged. The audio pipe lives
// for the page, not for one recogniser: a restart never stops the audio, and text that lands
// while no recogniser is started waits for the next one. Nothing he says is dropped, except while
// muted: mute is absolute (spec 005, Mark 2026-10-18). Muted audio never leaves the page, and the
// socket (with the daemon's half-heard utterance), the backlog and unsent audio are thrown away at
// mute. Before this, muted speech reached the daemon, its final waited in the backlog, and the
// recogniser started at unmute replayed it as his turn (2026-10-18 19:30:59).

import workletSrc from './pcm-worklet.js?raw';

const workletUrl = URL.createObjectURL(new Blob([workletSrc], { type: 'text/javascript' }));

type AsrEvent = { type: 'speechstart' } | { type: 'final'; text: string } | { type: 'error'; error: string };
type Result = ArrayLike<{ transcript: string }> & { isFinal: boolean };

let active: DaemonRecognition | null = null;
const backlog: AsrEvent[] = [];
let fed: MediaStream | null = null;
let sock: WebSocket | null = null;
// Audio captured while the socket is down is sent when it reconnects.
const unsent: Float32Array<ArrayBuffer>[] = [];
let muted = false;

/** Mute gate: muted, no audio leaves the page and no text from before or during mute survives. */
export function setMuted(m: boolean): void {
  muted = m;
  if (!m) return;
  backlog.length = 0;
  unsent.length = 0;
  const s = sock;
  sock = null;
  s?.close();
}

function connect(): void {
  const s = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/asr`);
  s.binaryType = 'arraybuffer';
  s.onopen = () => {
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
    if (sock === s) setTimeout(connect, 500);
  };
  sock = s;
}

/** Streams this mic to the daemon; a new stream replaces the old one, the same one is a no-op. */
export async function feed(stream: MediaStream): Promise<void> {
  if (fed === stream) return;
  fed = stream;
  if (!sock) connect();
  const ctx = new AudioContext({ sampleRate: 16000 });
  await ctx.audioWorklet.addModule(workletUrl);
  const node = new AudioWorkletNode(ctx, 'pcm');
  node.port.onmessage = (e: MessageEvent<Float32Array<ArrayBuffer>>) => {
    if (fed !== stream || muted) return;
    if (!sock) connect();
    if (sock?.readyState === WebSocket.OPEN) sock.send(e.data);
    else unsent.push(e.data);
  };
  ctx.createMediaStreamSource(stream).connect(node);
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
    else {
      this.results.push(Object.assign([{ transcript: e.text }], { isFinal: true }));
      this.onresult?.({ resultIndex: this.results.length - 1, results: this.results });
      this.onspeechend?.();
    }
  }
}
