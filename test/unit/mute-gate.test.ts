import { describe, expect, it, vi } from 'vitest';

// Mute is absolute (spec 005, 2026-10-18 19:30:59): speech while muted reached the daemon, its
// final waited in the backlog, and the recogniser started at unmute replayed it as his turn.

const sockets: FakeSocket[] = [];
class FakeSocket {
  static OPEN = 1;
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
  it('drops speech heard before and during mute; only speech after unmute is a turn', async () => {
    const { DaemonRecognition, feed, setMuted } = await import('../../web/daemonRecognition.ts');
    await feed({} as MediaStream);
    const first = sockets[0] as FakeSocket;
    // No recogniser running (listen ended): this final would wait in the backlog.
    first.say('said before mute');
    setMuted(true);
    expect(first.closed).toBe(true);
    // Late text on the old socket, and mic audio while muted, go nowhere.
    first.say('I am speaking while muted');
    frame?.({ data: new Float32Array(4) });
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
});
