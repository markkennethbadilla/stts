// Spec 014: the daemon's speech engine.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { type AsrEvent, asrPaths, createEngine, MODEL } from '../../src/asr';

// The real data folder (the test setup points LOCALAPPDATA at a scratch folder).
const dataDir = process.env['STTS_ASR_DATA'] ?? join(homedir(), 'AppData', 'Local', 'cc-gc-stts');

it('a missing engine says how to install it, once, and takes audio without throwing', () => {
  const events: AsrEvent[] = [];
  const e = createEngine(mkdtempSync(join(tmpdir(), 'stts-asr-')), (ev) => events.push(ev));
  e.push(new Float32Array(1600));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: 'error' });
  expect((events[0] as { error: string }).error).toMatch(/setup-stts\.ps1 -Apply/);
});

// Needs the installed engine (mkb-agentops setup-stts.ps1); skipped where it is not installed.
const installed =
  existsSync(join(asrPaths(dataDir).model, 'test_wavs', '0.wav')) && existsSync(asrPaths(dataDir).addon);
it.skipIf(!installed)(
  `${MODEL} hears every word, in odd-sized chunks, with nothing dropped across chunk edges`,
  async () => {
    const buf = readFileSync(join(asrPaths(dataDir).model, 'test_wavs', '0.wav'));
    const pcm = new Int16Array(buf.buffer, buf.byteOffset + 44, (buf.length - 44) >> 1);
    const f = Float32Array.from(pcm, (v) => v / 32768);
    const events: AsrEvent[] = [];
    const e = createEngine(dataDir, (ev) => events.push(ev));
    for (let i = 0; i < f.length; i += 777) e.push(f.subarray(i, i + 777));
    e.push(new Float32Array(16000));
    await new Promise((r) => setTimeout(r, 8000));
    const text = events
      .filter((x) => x.type === 'final')
      .map((x) => (x as { text: string }).text)
      .join(' ');
    expect(events[0]).toEqual({ type: 'speechstart' });
    expect(text.toLowerCase()).toMatch(/well, i don't wish to see it any more, observed phoebe.*old portrait/);
  },
  60_000,
);
