// Chrome's SpeechRecognition (spec 014), restarted at once when Chrome ends a session, words kept across restarts.

type Result = ArrayLike<{ transcript: string }> & { isFinal: boolean };
type Native = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  onaudiostart: (() => void) | null;
  onresult: ((e: { resultIndex: number; results: ArrayLike<Result> }) => void) | null;
  start(track?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
};
type Ctor = new () => Native;

// Errors that only mean this session is over: the next one starts at once.
const RESTART = new Set(['no-speech', 'aborted', 'network']);
// A session that ended sooner than this waits before the restart, so a dead service never spins.
const QUICK_MS = 500;
const QUICK_WAIT_MS = 300;

const plain = (text: string, isFinal: boolean): Result => Object.assign([{ transcript: text }], { isFinal });

export class ChromeRecognition {
  continuous = true;
  interimResults = true;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error?: string }) => void) | null = null;
  onspeechstart: (() => void) | null = null;
  onspeechend: (() => void) | null = null;
  onaudiostart: (() => void) | null = null;
  onresult: ((e: { resultIndex: number; results: ArrayLike<Result> }) => void) | null = null;
  // Results of sessions that ended; the live session's results follow them.
  private base: Result[] = [];
  private session: Result[] = [];
  private native: Native | null = null;
  private track: MediaStreamTrack | undefined;
  private running = false;
  private begun = false;
  private fatal = false;

  start(track?: MediaStreamTrack): void {
    this.track = track;
    this.running = true;
    this.open();
  }

  stop(): void {
    this.running = false;
    this.native?.stop();
  }

  abort(): void {
    this.running = false;
    this.native?.abort();
  }

  private open(): void {
    const g = globalThis as unknown as { SpeechRecognition?: Ctor; webkitSpeechRecognition?: Ctor };
    const C = g.SpeechRecognition ?? g.webkitSpeechRecognition;
    if (!C) {
      this.onerror?.({ error: 'service-not-allowed' });
      this.running = false;
      this.finish();
      return;
    }
    const n = new C();
    this.native = n;
    this.session = [];
    const at = Date.now();
    n.continuous = true;
    n.interimResults = true;
    n.lang = 'en-US';
    n.onstart = () => {
      if (this.begun) return;
      this.begun = true;
      this.onstart?.();
    };
    n.onaudiostart = () => this.native === n && this.onaudiostart?.();
    n.onspeechstart = () => this.native === n && this.onspeechstart?.();
    n.onspeechend = () => this.native === n && this.onspeechend?.();
    n.onresult = (e) => {
      if (this.native !== n) return;
      this.session = Array.from(e.results, (r) => plain(r[0]?.transcript ?? '', r.isFinal));
      this.onresult?.({ resultIndex: this.base.length + e.resultIndex, results: [...this.base, ...this.session] });
    };
    n.onerror = (e) => {
      if (this.native !== n || (e.error && RESTART.has(e.error))) return;
      this.fatal = true;
      this.onerror?.(e);
    };
    n.onend = () => {
      if (this.native !== n) return;
      this.native = null;
      // Words still forming when Chrome ended the session are kept as heard.
      const interim = this.session.at(-1)?.isFinal === false;
      this.base.push(...this.session.map((r) => plain(r[0]?.transcript ?? '', true)));
      this.session = [];
      if (!this.running || this.fatal) {
        this.finish();
        return;
      }
      if (interim) this.onresult?.({ resultIndex: this.base.length - 1, results: this.base });
      const again = (): void => {
        if (!this.running) {
          this.finish();
          return;
        }
        try {
          this.open();
        } catch {
          this.onerror?.({ error: 'network' });
          this.running = false;
          this.finish();
        }
      };
      if (Date.now() - at < QUICK_MS) setTimeout(again, QUICK_WAIT_MS);
      else again();
    };
    try {
      n.start(this.track);
    } catch {
      n.start();
    }
  }

  private finish(): void {
    this.base = [];
    this.begun = false;
    this.fatal = false;
    this.onend?.();
  }
}
