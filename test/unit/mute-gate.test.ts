import { describe, expect, it, vi } from 'vitest';

// Mute is absolute (spec 005, 2026-10-18 19:30:59): speech while muted reached the daemon, its
// final waited in the backlog, and the recogniser started at unmute replayed it as his turn.

const sockets: FakeSocket[] = [];
class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 1;
  sent: unknown[] = [];
  closed = false;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() {
    sockets.push(this);
  }
  send(d: unknown) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  say(text: string) {
    this.onmessage?.({ data: JSON.stringify({ type: 'final', text }) });
  }
}
let frame: ((e: { data: Float32Array }) => void) | null = null;
vi.stubGlobal('WebSocket', FakeSocket);
vi.stubGlobal('location', { protocol: 'http:', host: 'x' });
vi.stubGlobal(
  'AudioContext',
  class {
    audioWorklet = { addModule: async () => {} };
    state = 'running';
    createMediaStreamSource() {
      return { connect() {} };
    }
  },
);
vi.stubGlobal(
  'AudioWorkletNode',
  class {
    port = {
      set onmessage(f: (e: { data: Float32Array }) => void) {
        frame = f;
      },
    };
  },
);
URL.createObjectURL = () => 'blob:x';

describe('mute gate', () => {
  // Mark 2026-10-18: "after I say something and mute right after, it never sends it".
  it('sends speech from before the mute, drops speech during it; only after unmute is a turn', async () => {
    const { DaemonRecognition, feed, setMuted } = await import('../../web/daemonRecognition.ts');
    await feed({} as MediaStream);
    const first = sockets[0] as FakeSocket;
    // No recogniser running (listen ended): this final waits in the backlog.
    first.say('said before mute');
    let flushed: string[] | null = null;
    setMuted(true, (f) => {
      flushed = f;
    });
    // The daemon is asked to decode the utterance cut off by the mute; the socket stays for it.
    expect(first.sent.at(-1)).toBe('flush');
    expect(first.closed).toBe(false);
    // Mic audio while muted goes nowhere.
    frame?.({ data: new Float32Array(4) });
    expect(first.sent.at(-1)).toBe('flush');
    first.say('and the words in flight');
    first.onmessage?.({ data: JSON.stringify({ type: 'flushed' }) });
    expect(flushed).toEqual(['said before mute', 'and the words in flight']);
    expect(first.closed).toBe(true);
    // Late text on the old socket goes nowhere.
    first.say('I am speaking while muted');
    expect(sockets).toHaveLength(1);
    setMuted(false);
    frame?.({ data: new Float32Array(4) });
    const second = sockets[1] as FakeSocket;
    expect(second.sent).toHaveLength(1);
    const heard: string[] = [];
    const r = new DaemonRecognition();
    r.onresult = (e) =>
      heard.push((e.results[e.resultIndex] as ArrayLike<{ transcript: string }>)[0]?.transcript ?? '');
    r.start();
    await Promise.resolve();
    second.say('after unmute');
    expect(heard).toEqual(['after unmute']);
  });

  // Mark 2026-10-18 21:28 and 21:34: "I unmuted and spoke and it never registered".
  it('unmute opens a socket at once; speech before it is open is sent when it opens; a stall rebuilds', async () => {
    vi.useFakeTimers();
    const { setMuted } = await import('../../web/daemonRecognition.ts');
    setMuted(true);
    const before = sockets.length;
    const stalls: string[] = [];
    setMuted(false, undefined, (why) => stalls.push(why));
    // The socket opens on unmute, not on the first frame.
    expect(sockets).toHaveLength(before + 1);
    const s = sockets.at(-1) as FakeSocket;
    s.readyState = 0;
    // He speaks at once, before the socket is open: the audio waits, then is sent first thing.
    frame?.({ data: new Float32Array(4) });
    frame?.({ data: new Float32Array(4) });
    expect(s.sent).toHaveLength(0);
    s.readyState = 1;
    s.onopen?.();
    expect(s.sent).toHaveLength(2);
    vi.advanceTimersByTime(3000);
    expect(stalls).toEqual([]);
    // No mic audio after an unmute: the mic is reopened.
    setMuted(true);
    setMuted(false, undefined, (why) => stalls.push(why));
    vi.advanceTimersByTime(3000);
    expect(stalls).toHaveLength(1);
    vi.useRealTimers();
  });
});
