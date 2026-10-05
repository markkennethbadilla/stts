// Shared e2e fixture: a fake SpeechRecognition, earcons off, page.clock installed, and a
// failure on any pageerror or console error.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';
import { dataRoot } from '../../playwright.config.ts';

export const logFile =
  process.platform === 'win32'
    ? join(dataRoot, 'cc-gc-stts', 'daemon.log')
    : join(dataRoot, '.local', 'share', 'cc-gc-stts', 'daemon.log');
export const daemonLog = (): string => readFileSync(logFile, 'utf-8');

export const test = base.extend<{ voice: Page }>({
  voice: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console ${m.text()}`);
    });
    await page.clock.install();
    await page.addInitScript(() => {
      localStorage.setItem('__stts__earcons', '0');
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
        stop(): void {
          setTimeout(() => this.onend?.(), 0);
        }
      }
      g['SpeechRecognition'] = FakeRecognition;
      g['__say'] = (text: string): void => {
        const r = g['__rec'] as FakeRecognition;
        r.onspeechstart?.();
        r.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] });
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
