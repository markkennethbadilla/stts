// Screenshots of the orb screen at 1600x600 and 390 wide against `vite preview`, with /ws
// mocked. Fails on any page error or console error. Run: node test/screenshots/shoot.ts <url>
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://127.0.0.1:4173/';
const out = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const errors: string[] = [];
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-gl=swiftshader'],
});

for (const [name, width, height] of [
  ['strip-1600x600', 1600, 600],
  ['phone-390', 390, 844],
] as const) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (e) => errors.push(`${name} pageerror ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${name} console ${m.text()}`));
  let send: (m: object) => void = () => {};
  await page.routeWebSocket('**/ws', (ws) => {
    send = (m) => ws.send(JSON.stringify(m));
  });
  // Piper stand-in: two seconds of silent 8 kHz mono WAV per clip.
  const pcm = 16000;
  const wav = Buffer.alloc(44 + pcm);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + pcm, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(8000, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm, 40);
  wav.fill(128, 44);
  await page.route('**/voice/clip', (r) => r.fulfill({ status: 200, contentType: 'audio/wav', body: wav }));
  // Headless Chrome has no speech service: a stand-in recogniser that starts and reports words.
  await page.addInitScript(() => {
    class FakeRec {
      onstart: (() => void) | null = null;
      onresult: ((e: unknown) => void) | null = null;
      onspeechend: (() => void) | null = null;
      start() {
        (globalThis as unknown as { __rec: FakeRec }).__rec = this;
        setTimeout(() => this.onstart?.(), 50);
      }
      stop() {}
    }
    (globalThis as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeRec;
  });
  await page.goto(url);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${out}${name}-idle.png` });
  send({ type: 'request', id: 1, body: { kind: 'stt', who: 'session' } });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}${name}-listening.png` });
  await page.evaluate(() => {
    const r = (globalThis as unknown as { __rec: { onresult: (e: unknown) => void } }).__rec;
    const res = Object.assign([{ transcript: 'read me the next chapter and' }], { isFinal: false });
    r.onresult({ resultIndex: 0, results: [res] });
  });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}${name}-interim.png` });
  // Speech end with final words arms autosend: the countdown ring shrinks around the orb.
  await page.evaluate(() => {
    const r = (globalThis as unknown as { __rec: { onresult: (e: unknown) => void; onspeechend: () => void } }).__rec;
    const res = Object.assign([{ transcript: 'read me the next chapter' }], { isFinal: true });
    r.onresult({ resultIndex: 0, results: [res] });
    r.onspeechend();
  });
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${out}${name}-countdown.png` });
  await page.waitForTimeout(1000);
  // A long reply: the words must never run under the wave (Mark, 2026-10-06).
  const long = 'Chapter two. The orb wakes, and the long reply keeps going so the words fill the window. '.repeat(10);
  send({ type: 'request', id: 2, body: { kind: 'tts', text: long, who: 'session' } });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}${name}-speaking.png` });
  const gap = await page.evaluate(() => {
    const s = document.querySelector('section')?.getBoundingClientRect();
    const w = document.querySelector('section + div')?.getBoundingClientRect();
    const h = document.querySelector('header')?.getBoundingClientRect();
    return s && w && h ? Math.min(w.top - s.bottom, s.top - h.bottom) : -1;
  });
  if (gap < 0) errors.push(`${name} words overlap the wave or header by ${-gap}px`);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}${name}-settings.png` });
  await page.close();
}
await browser.close();
console.log(errors.length ? `[FAIL]\n${errors.join('\n')}` : '[OK] zero console errors');
process.exitCode = errors.length ? 1 : 0;
