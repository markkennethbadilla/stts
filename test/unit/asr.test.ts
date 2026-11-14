// Spec 014: the daemon's speech engine.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { type AsrEvent, asrPaths, createEngine, MODEL } from '../../src/asr';

// The real data folder (the test setup points LOCALAPPDATA at a scratch folder).
const dataDir = process.env['STTS_ASR_DATA'] ?? join(homedir(), 'AppData', 'Local', 'stts');

it('a missing engine says how to install it, once, and takes audio without throwing', () => {
  const events: AsrEvent[] = [];
  const empty = mkdtempSync(join(tmpdir(), 'stts-asr-'));
  const e = createEngine(asrPaths(empty, empty), (ev) => events.push(ev));
  e.push(new Float32Array(1600));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: 'error' });
  expect((events[0] as { error: string }).error).toMatch(/setup-stts\.ps1 -Apply/);
});

// Needs the installed engine (mkb-agentops setup-stts.ps1); skipped where it is not installed.
const p = asrPaths(dataDir, process.env['STTS_MODELS_DIR'] ?? 'A:\\models');
const installed = [p.addon, p.vad, p.python, join(p.model, 'encoder-model.int8.onnx')].every((f) => existsSync(f));
it.skipIf(!installed)(
  `${MODEL} hears every word, in odd-sized chunks, with nothing dropped across chunk edges`,
  async () => {
    const buf = readFileSync('test/fixtures/phoebe.wav');
    const pcm = new Int16Array(buf.buffer, buf.byteOffset + 44, (buf.length - 44) >> 1);
    const f = Float32Array.from(pcm, (v) => v / 32768);
    const warm: AsrEvent[] = [];
    const w = createEngine(p, (ev) => warm.push(ev));
    w.push(f.subarray(0, 32000));
    w.flush();
    for (let i = 0; i < 100 && !warm.some((x) => x.type === 'flushed'); i++)
      await new Promise((r) => setTimeout(r, 300));
    const events: AsrEvent[] = [];
    const e = createEngine(p, (ev) => events.push(ev));
    for (let i = 0, n = 0; i < f.length; i += 777, n++) {
      e.push(f.subarray(i, i + 777));
      // The speed of speech: faster, a busy machine finishes no live decode before the segment ends.
      if (n % 3 === 2) await new Promise((r) => setTimeout(r, 146));
    }
    e.push(new Float32Array(16000));
    for (let i = 0; i < 100 && !events.some((x) => x.type === 'final' && /portrait/.test(x.text)); i++)
      await new Promise((r) => setTimeout(r, 300));
    const text = events
      .filter((x) => x.type === 'final')
      .map((x) => (x as { text: string }).text)
      .join(' ');
    expect(events[0]).toEqual({ type: 'speechstart' });
    const firstFinal = events.findIndex((x) => x.type === 'final');
    const interims = events.slice(0, firstFinal).filter((x) => x.type === 'interim');
    expect(interims.length).toBeGreaterThan(1);
    expect((interims[0] as { text: string }).text.toLowerCase()).toMatch(/^well/);
    expect(text.toLowerCase()).toMatch(/^well, i don't wish to see it any ?more, observed phoebe.*old portrait\.$/);
  },
  60_000,
);
