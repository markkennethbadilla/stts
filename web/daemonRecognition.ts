// The page's recogniser (spec 014): the echo-cancelled mic stream goes to the daemon over /asr as
// 16 kHz audio, and the daemon's sherpa-onnx engine sends back speechstart and final text. It has
// the shape of Chrome's SpeechRecognition, so the page machine is unchanged. The audio pipe lives
// for the page, not for one recogniser: a restart never stops the audio, and text that lands
// while no recogniser is started waits for the next one. Nothing he says is dropped.

type AsrEvent = { type: 'speechstart' } | { type: 'final'; text: string } | { type: 'error'; error: string };
type Result = ArrayLike<{ transcript: string }> & { isFinal: boolean };

let active: DaemonRecognition | null = null;
const backlog: AsrEvent[] = [];
let fed: MediaStream | null = null;
let sock: WebSocket | null = null;
// Audio captured while the socket is down is sent when it reconnects.
const unsent: Float32Array<ArrayBuffer>[] = [];

function connect(): void {
  const s = new WebSocket(`ws://${location.host}/asr`);
  s.binaryType = 'arraybuffer';
  s.onopen = () => {
    for (const f of unsent.splice(0)) s.send(f);
  };
  s.onmessage = (e) => {
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
  await ctx.audioWorklet.addModule('/pcm-worklet.js');
  const node = new AudioWorkletNode(ctx, 'pcm');
  node.port.onmessage = (e: MessageEvent<Float32Array<ArrayBuffer>>) => {
    if (fed !== stream) return;
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
