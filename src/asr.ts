// Speech to text in the daemon (spec 014): sherpa-onnx (k2-fsa, Apache-2.0) with Silero VAD and
// NVIDIA Parakeet TDT 0.6B v2 int8, all on this machine. The page streams echo-cancelled 16 kHz
// audio over /asr; every VAD segment is decoded, in order, so nothing heard is ever dropped.
// Replaces Chrome's Web Speech recogniser, which lost words on restarts (Mark 2026-10-07).
// The addon and models are installed by mkb-agentops scripts/setup-stts.ps1 (like Piper), because
// the plugin ships without node_modules and a native addon cannot be bundled.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export const SAMPLE_RATE = 16000;
export const MODEL = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8';
const WINDOW = 512; // Silero's window at 16 kHz

export type AsrEvent = { type: 'speechstart' } | { type: 'final'; text: string } | { type: 'error'; error: string };

type Sherpa = {
  OfflineRecognizer: new (
    c: unknown,
  ) => {
    createStream(): { acceptWaveform(w: { samples: Float32Array; sampleRate: number }): void };
    decodeAsync(s: unknown): Promise<{ text: string }>;
  };
  Vad: new (
    c: unknown,
    sec: number,
  ) => {
    acceptWaveform(s: Float32Array): void;
    isEmpty(): boolean;
    front(): { samples: Float32Array };
    pop(): void;
    isDetected(): boolean;
    flush(): void;
  };
};

export const asrPaths = (dataDir: string) => ({
  addon: join(dataDir, 'asr', 'node_modules', 'sherpa-onnx-node'),
  model: join(dataDir, 'models', MODEL),
  vad: join(dataDir, 'models', 'silero_vad.onnx'),
});

let sherpa: Sherpa | null = null;
let recognizer: InstanceType<Sherpa['OfflineRecognizer']> | null = null;

/** Loads the addon and the model once per daemon; throws a plain message when they are missing. */
function load(dataDir: string): Sherpa {
  const p = asrPaths(dataDir);
  for (const f of [p.addon, join(p.model, 'encoder.int8.onnx'), p.vad])
    if (!existsSync(f)) throw new Error(`speech engine not installed (${f}); run mkb-agentops setup-stts.ps1 -Apply`);
  sherpa ??= createRequire(import.meta.url)(p.addon) as Sherpa;
  recognizer ??= new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(p.model, 'encoder.int8.onnx'),
        decoder: join(p.model, 'decoder.int8.onnx'),
        joiner: join(p.model, 'joiner.int8.onnx'),
      },
      tokens: join(p.model, 'tokens.txt'),
      numThreads: 4,
      provider: 'cpu',
      modelType: 'nemo_transducer',
    },
  });
  return sherpa;
}

/** One page connection: its own VAD, the shared recognizer. Push 16 kHz mono float samples. */
export function createEngine(dataDir: string, emit: (e: AsrEvent) => void): { push(s: Float32Array): void } {
  let vad: InstanceType<Sherpa['Vad']>;
  try {
    const s = load(dataDir);
    vad = new s.Vad(
      {
        // ponytail: Silero defaults from the upstream example, silence 0.5 s ends a segment; the page's
        // autosend hold still decides when a turn ends, so a short pause only splits segments.
        sileroVad: {
          model: asrPaths(dataDir).vad,
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
    return { push: () => {} };
  }
  let pending = new Float32Array(0);
  let speaking = false;
  // Decodes run one after another, so finals arrive in the order he spoke them.
  let chain = Promise.resolve();
  const drain = (): void => {
    while (!vad.isEmpty()) {
      const samples = vad.front().samples;
      vad.pop();
      chain = chain.then(async () => {
        const st = recognizer?.createStream();
        if (!st || !recognizer) return;
        st.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
        const text = (await recognizer.decodeAsync(st)).text.trim();
        if (text) emit({ type: 'final', text });
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
      pending = all.slice(i);
      const now = vad.isDetected();
      if (now && !speaking) emit({ type: 'speechstart' });
      speaking = now;
      drain();
    },
  };
}
