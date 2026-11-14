// Speech to text in the daemon (spec 014): sherpa-onnx (k2-fsa, Apache-2.0) with Silero VAD and
// NVIDIA Parakeet TDT 0.6B v3 int8, all on this machine. The page streams echo-cancelled 16 kHz
// audio over /asr; every VAD segment is decoded, in order, so nothing heard is ever dropped.
// Replaces Chrome's Web Speech recogniser, which lost words on restarts (Mark 2026-10-07).
// sherpa-onnx is the voice detector only; the words come from Parakeet in the models folder (modelsDir), read by onnx-asr in asr_worker.py.
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const SAMPLE_RATE = 16000;
// 0.3 s of audio before each segment (a segment ends after 0.5 s of silence, so this never reaches
// the previous one); audio is kept a little longer than the longest segment (20 s).
const PRE_ROLL = 0.3 * 16000;
const KEEP = 22 * 16000;
export const MODEL = 'parakeet-tdt-0.6b-v3-int8';
const ONNX_ASR_NAME = 'nemo-parakeet-tdt-0.6b-v3';
const WINDOW = 512; // Silero's window at 16 kHz
const INTERIM_EVERY = 0.4 * 16000;
const INTERIM_LEAD = 0.6 * 16000;

export type AsrEvent =
  | { type: 'speechstart' }
  | { type: 'final'; text: string }
  | { type: 'interim'; text: string }
  | { type: 'nowords' }
  | { type: 'error'; error: string }
  // Every final for the audio pushed before a flush has been sent (spec 005: mute keeps pre-mute speech).
  | { type: 'flushed' };

type Sherpa = {
  Vad: new (
    c: unknown,
    sec: number,
  ) => {
    acceptWaveform(s: Float32Array): void;
    isEmpty(): boolean;
    front(): { samples: Float32Array; start: number };
    pop(): void;
    isDetected(): boolean;
    flush(): void;
  };
};

export const asrPaths = (dataDir: string, modelsDir: string) => ({
  addon: join(dataDir, 'asr', 'node_modules', 'sherpa-onnx-node'),
  model: join(modelsDir, 'parakeet', MODEL),
  vad: join(dataDir, 'models', 'silero_vad.onnx'),
  python: join(
    process.env['STTS_PIPER_HOME'] ?? join(dataDir, 'piper'),
    'venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  ),
  worker: join(dirname(fileURLToPath(import.meta.url)), 'asr_worker.py'),
});
export type AsrPaths = ReturnType<typeof asrPaths>;

let sherpa: Sherpa | null = null;
let worker: ChildProcess | null = null;
let downUntil = 0;
let lastFail = '';
let wlog: (line: string) => void = () => {};
const waiting: ((text: string) => void)[] = [];

/** Loads the addon once per daemon; throws a plain message when a part is missing. */
function load(p: AsrPaths): Sherpa {
  for (const f of [p.addon, join(p.model, 'encoder-model.int8.onnx'), p.vad, p.python])
    if (!existsSync(f))
      throw new Error(
        `speech engine not installed (${f}); the first start fetches it (see daemon.log), or run node scripts/install.mjs`,
      );
  sherpa ??= createRequire(import.meta.url)(p.addon) as Sherpa;
  return sherpa;
}

function startWorker(p: AsrPaths): ChildProcess {
  const w = spawn(p.python, [p.worker, ONNX_ASR_NAME, p.model], { stdio: 'pipe', windowsHide: true });
  wlog(`asr worker START pid ${w.pid} ${MODEL}`);
  let err = '';
  w.stderr?.on('data', (d) => {
    err = (err + String(d)).slice(-2000);
  });
  if (w.stdout)
    createInterface({ input: w.stdout }).on('line', (line) => {
      let r: { text?: string; error?: string };
      try {
        r = JSON.parse(line);
      } catch {
        return;
      }
      if (r.error) wlog(`asr worker FAIL ${r.error}`);
      waiting.shift()?.((r.text ?? '').trim());
    });
  const gone = (why: string): void => {
    if (worker !== w) return;
    worker = null;
    downUntil = Date.now() + 30_000;
    lastFail = `${why} ${err.trim().split('\n').pop() ?? ''}`;
    wlog(`asr worker FAIL ${lastFail}`);
    for (const f of waiting.splice(0)) f('');
  };
  w.on('error', (e) => gone(String(e)));
  w.on('exit', (code) => gone(`exit ${code}`));
  w.stdin?.on('error', () => {});
  return w;
}

function decode(p: AsrPaths, samples: Float32Array): Promise<string> {
  if (!worker && Date.now() < downUntil) return Promise.resolve('');
  worker ??= startWorker(p);
  const w = worker;
  return new Promise((res) => {
    waiting.push(res);
    const head = Buffer.alloc(4);
    head.writeUInt32LE(samples.byteLength);
    w.stdin?.write(head);
    w.stdin?.write(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  });
}

export function stopAsr(): void {
  const w = worker;
  worker = null;
  w?.kill();
}

/** Starts the worker at daemon start, so the model (about 5 s) is loaded before he speaks. A missing
 * engine is reported per connection instead. */
export function preload(p: AsrPaths, log: (line: string) => void = () => {}): void {
  wlog = log;
  try {
    load(p);
    worker ??= startWorker(p);
  } catch {}
}

/** One page connection: its own VAD, the shared worker. Push 16 kHz mono float samples. */
export function createEngine(
  p: AsrPaths,
  emit: (e: AsrEvent) => void,
  log: (line: string) => void = () => {},
): { push(s: Float32Array): void; flush(): void } {
  let vad: InstanceType<Sherpa['Vad']>;
  try {
    const s = load(p);
    vad = new s.Vad(
      {
        // ponytail: Silero defaults from the upstream example, silence 0.5 s ends a segment; the page's
        // autosend hold still decides when a turn ends, so a short pause only splits segments.
        sileroVad: {
          model: p.vad,
          threshold: 0.5,
          minSpeechDuration: 0.25,
          minSilenceDuration: 0.5,
          maxSpeechDuration: 20,
          windowSize: WINDOW,
        },
        sampleRate: SAMPLE_RATE,
        numThreads: 1,
      },
      60,
    );
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    emit({ type: 'error', error });
    return { push: () => {}, flush: () => emit({ type: 'flushed' }) };
  }
  if (!worker && Date.now() < downUntil)
    emit({
      type: 'error',
      error: `speech worker failed (${lastFail}); see daemon.log; node scripts/install.mjs --check lists missing parts`,
    });
  let pending = new Float32Array(0);
  let speaking = false;
  // Recent audio by absolute sample index, for the pre-roll: Silero marks a segment's start just
  // after the first word begins, and the second half of a paused sentence came back without its
  // first word ("colour", live test 2026-10-07).
  const kept: { at: number; s: Float32Array }[] = [];
  let fedTotal = 0;
  const span = (from: number, to: number): Float32Array => {
    const out = new Float32Array(Math.max(0, to - from));
    for (const c of kept) {
      const a = Math.max(from, c.at);
      const b = Math.min(to, c.at + c.s.length);
      if (a < b) out.set(c.s.subarray(a - c.at, b - c.at), a - from);
    }
    return out;
  };
  const before = (start: number): Float32Array => span(Math.max(0, start - PRE_ROLL), start);
  // Decodes run one after another, so finals arrive in the order he spoke them.
  let chain = Promise.resolve();
  let from = 0;
  let interimAt = 0;
  let interimBusy = false;
  let lastInterim = '';
  let gen = 0;
  let segments = 0;
  const interim = (): void => {
    if (interimBusy || fedTotal - interimAt < INTERIM_EVERY) return;
    interimBusy = true;
    interimAt = fedTotal;
    const mine = gen;
    const samples = span(from, fedTotal);
    chain = chain.then(async () => {
      const text = mine === gen ? await decode(p, samples) : '';
      interimBusy = false;
      if (mine !== gen || !text || text === lastInterim) return;
      lastInterim = text;
      emit({ type: 'interim', text });
    });
  };
  const drain = (): void => {
    while (!vad.isEmpty()) {
      const seg = vad.front();
      vad.pop();
      const pre = before(seg.start);
      // 0.3 s of silence after a segment: without it the v3 model added words that were not said or dropped one.
      const samples = new Float32Array(pre.length + seg.samples.length + 0.3 * SAMPLE_RATE);
      samples.set(pre);
      samples.set(seg.samples, pre.length);
      gen++;
      segments++;
      const seen = lastInterim;
      lastInterim = '';
      from = seg.start + seg.samples.length;
      chain = chain.then(async () => {
        const t0 = Date.now();
        const heard = await decode(p, samples);
        // The v3 model sometimes decodes a whole segment to nothing after reading its start correctly: keep the live words.
        const text = heard || seen;
        log(
          `asr segment ${(samples.length / SAMPLE_RATE).toFixed(1)}s decoded in ${Date.now() - t0}ms, ${text ? text.split(/\s+/).length : 0} words${heard || !seen ? '' : ' (decode empty, live words kept)'}`,
        );
        emit(text ? { type: 'final', text } : { type: 'nowords' });
      });
    }
  };
  return {
    push(s) {
      const all = new Float32Array(pending.length + s.length);
      all.set(pending);
      all.set(s, pending.length);
      let i = 0;
      for (; i + WINDOW <= all.length; i += WINDOW) vad.acceptWaveform(all.subarray(i, i + WINDOW));
      kept.push({ at: fedTotal, s: all.slice(0, i) });
      fedTotal += i;
      while (kept.length && (kept[0]?.at ?? 0) < fedTotal - KEEP) kept.shift();
      pending = all.slice(i);
      const now = vad.isDetected();
      if (now && !speaking) {
        emit({ type: 'speechstart' });
        from = Math.max(0, fedTotal - INTERIM_LEAD);
        interimAt = fedTotal;
        segments = 0;
      }
      drain();
      if (now) interim();
      else if (speaking && segments === 0) {
        gen++;
        lastInterim = '';
        log('asr sound with no speech segment');
        chain = chain.then(() => emit({ type: 'nowords' }));
      }
      speaking = now;
    },
    // Mute: the utterance still in the VAD is cut off where the audio stopped and decoded now.
    flush() {
      vad.flush();
      speaking = false;
      drain();
      chain = chain.then(() => emit({ type: 'flushed' }));
    },
  };
}
