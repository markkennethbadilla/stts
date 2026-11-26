// Spec 006 lyrics view: two clips into a long reply the third line sits across the words pane's middle at every shoot.ts size.
import { expect, test } from '@playwright/test';
import { fakeVoice } from '../fake-voice';

const SIZES: [string, number, number, string][] = [
  ['strip-1600x600', 1600, 600, 'dark'],
  ['phone-390', 390, 844, 'dark'],
  ['window-462x689', 462, 689, 'dark'],
  ['short-800x320', 800, 320, 'dark'],
  ['light-462x689', 462, 689, 'light'],
];

for (const [name, width, height, theme] of SIZES)
  test(`the playing line is in view at ${name}`, { tag: '@smoke' }, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.addInitScript(fakeVoice, 1500);
    await page.addInitScript((t) => localStorage.setItem('__stts__theme', t), theme);
    const ws: { send?: (m: object) => void } = {};
    await page.routeWebSocket('**/ws', (route) => {
      ws.send = (m) => route.send(JSON.stringify(m));
    });
    await page.goto('/');
    await expect.poll(() => ws.send !== undefined).toBe(true);
    const long = 'Chapter two. The orb wakes, and the long reply keeps going so the words fill the window. '.repeat(10);
    ws.send?.({ type: 'request', id: 2, body: { kind: 'tts', text: long, who: 'session' } });
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const pane = document.querySelector('section')?.getBoundingClientRect();
            const el = document.querySelector('[data-line="2"]');
            const line = el?.getBoundingClientRect();
            if (!pane || !line || el?.className.includes('/35')) return 'line 2 not lit';
            const mid = (pane.top + pane.bottom) / 2;
            return line.top <= mid && line.bottom >= mid ? 'in view' : `line ${line.top}-${line.bottom}, mid ${mid}`;
          }),
        { timeout: 15_000 },
      )
      .toBe('in view');
  });
