// Shared e2e fixture: a fake recogniser (in place of the daemon's engine), earcons off, page.clock installed, and a
// failure on any pageerror or console error.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';
import { dataRoot } from '../../playwright.config.ts';

export const logFile =
  process.platform === 'win32'
    ? join(dataRoot, 'stts', 'daemon.log')
    : join(dataRoot, '.local', 'share', 'stts', 'daemon.log');
export const daemonLog = (): string => readFileSync(logFile, 'utf-8');

let clockStep = 0;

export const test = base.extend<{ voice: Page }>({
  voice: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console ${m.text()}`);
    });
    // One daemon serves every test and drops a turn that ended before the last one (stale), by page
    // time. Each test's clock starts an hour after the previous one's, so a test that fast-forwarded
    // never makes the next test's words stale.
    await page.clock.install({ time: Date.now() + 3_600_000 * ++clockStep });
    await page.addInitScript(() => {
      localStorage.setItem('__stts__cues', 'off');
      type Handler = ((e?: unknown) => void) | null;
      const g = globalThis as unknown as Record<string, unknown>;
      class FakeRecognition {
        continuous = false;
        interimResults = false;
        processLocally = false;
        onstart: Handler = null;
        onend: Handler = null;
        onerror: Handler = null;
        onspeechstart: Handler = null;
        onspeechend: Handler = null;
        onaudiostart: Handler = null;
        onresult: Handler = null;
        start(): void {
          g['__rec'] = this;
          setTimeout(() => {
            this.onstart?.();
            this.onaudiostart?.();
          }, 0);
        }
        abort(): void {
          setTimeout(() => this.onend?.(), 0);
        }
        stop(): void {
          setTimeout(() => this.onend?.(), 0);
        }
      }
      g['__sttsRecognition'] = FakeRecognition;
      // The fake browser voice: utterances after the first holdAfter wait for __ttsRelease().
      type Utt = { text: string; rate: number; onend: Handler };
      const tts = {
        spoken: [] as { text: string; rate: number }[],
        held: [] as Utt[],
        holdAfter: Infinity,
        paused: false,
        pauses: 0,
        resumes: 0,
      };
      g['__tts'] = tts;
      g['__ttsRelease'] = (): void => {
        for (const u of tts.held.splice(0)) u.onend?.();
      };
      g['SpeechSynthesisUtterance'] = class {
        rate = 1;
        volume = 1;
        voice = null;
        onend: Handler = null;
        onerror: Handler = null;
        onboundary: Handler = null;
        constructor(public text: string) {}
      };
      Object.defineProperty(globalThis, 'speechSynthesis', {
        value: {
          getVoices: () => [],
          addEventListener: () => {},
          removeEventListener: () => {},
          cancel: () => {
            tts.held.length = 0;
            tts.paused = false;
          },
          pause: () => {
            tts.paused = true;
            tts.pauses++;
          },
          resume: () => {
            if (tts.paused) tts.resumes++;
            tts.paused = false;
          },
          speak: (u: Utt) => {
            tts.spoken.push({ text: u.text, rate: u.rate });
            if (tts.spoken.length > tts.holdAfter) tts.held.push(u);
            else void Promise.resolve().then(() => u.onend?.());
          },
        },
      });
      // The mic level the page reads: silence unless a test sets __level (the fake device beeps).
      g['__level'] = 0;
      AnalyserNode.prototype.getFloatTimeDomainData = (buf: Float32Array) => {
        buf.fill(g['__level'] as number);
      };
      g['__say'] = (text: string): void => {
        const r = g['__rec'] as FakeRecognition;
        r.onspeechstart?.();
        // Like Chrome, a session's results only grow: each phrase is appended, resultIndex points at it.
        const holder = r as unknown as { list?: unknown[] };
        holder.list ??= [];
        const list = holder.list;
        list.push(Object.assign([{ transcript: text }], { isFinal: true }));
        r.onresult?.({ resultIndex: list.length - 1, results: list });
        r.onspeechend?.();
      };
    });
    await page.goto('/');
    // The page link is up once the daemon reports it open; a request before that opens a window.
    await expect
      .poll(async () => (await (await page.request.get('/barge')).json()) as unknown)
      .toEqual({ text: '', open: true });
    await expect(page.getByLabel('notListening')).toBeVisible();
    await use(page);
    expect(errors).toEqual([]);
  },
});
export { expect };

type Tts = { spoken: { text: string; rate: number }[]; holdAfter: number; pauses: number; resumes: number };
const tts = (p: Page) => p.evaluate(() => (globalThis as unknown as { __tts: Tts }).__tts);
export const spokenTexts = async (p: Page): Promise<string[]> => (await tts(p)).spoken.map((x) => x.text);
export const spokenRates = async (p: Page): Promise<number[]> => (await tts(p)).spoken.map((x) => x.rate);
export const voiceCount = async (p: Page, k: 'pauses' | 'resumes'): Promise<number> => (await tts(p))[k];
/** Utterances after the first `n` wait until releaseSpeech: the speech is still playing. */
export const holdSpeech = (p: Page, n = 0) =>
  p.evaluate((x) => {
    (globalThis as unknown as { __tts: Tts }).__tts.holdAfter = x;
  }, n);
export const releaseSpeech = (p: Page) =>
  p.evaluate(() => (globalThis as unknown as { __ttsRelease: () => void }).__ttsRelease());
