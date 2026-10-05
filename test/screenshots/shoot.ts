// Screenshots of the orb screen at 1600x600 and 390 wide against `vite preview`, with /ws
// mocked. Fails on any page error or console error. Run: node test/screenshots/shoot.ts <url>
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://127.0.0.1:4173/';
const out = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const errors: string[] = [];
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-gl=swiftshader'],
});

for (const [name, width, height, theme = 'dark'] of [
  ['strip-1600x600', 1600, 600],
  ['phone-390', 390, 844],
  // Mark's live window (2026-10-06) and a short strip.
  ['window-462x689', 462, 689],
  ['short-800x320', 800, 320],
  // A thin strip docked at the screen edge, and the light theme.
  ['strip-200x700', 200, 700],
  ['strip-240x700', 240, 700],
  ['light-462x689', 462, 689, 'light'],
] as [string, number, number, string?][]) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.addInitScript((t) => localStorage.setItem('__stts__theme', t), theme);
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
  // Header, orb, words and wave: no two may overlap at any size (Mark, 2026-10-06).
  const clash = await page.evaluate(() => {
    const boxes = (['header', '[data-orb]', 'section', '[data-wave]'] as const).map((q) => {
      const r = document.querySelector(q)?.getBoundingClientRect();
      return { q, r };
    });
    const out: string[] = [];
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const x = boxes[i]?.r;
        const y = boxes[j]?.r;
        if (!x || !y) continue;
        const w = Math.min(x.right, y.right) - Math.max(x.left, y.left);
        const h = Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top);
        if (w > 1 && h > 1) out.push(`${boxes[i]?.q} and ${boxes[j]?.q} overlap ${Math.round(w)}x${Math.round(h)}px`);
      }
    return out;
  });
  for (const c of clash) errors.push(`${name} ${c}`);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}${name}-settings.png` });
  // Keyboard mode: the box and the Send button fit, and the button drops under the box when narrow.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Switch to keyboard input' }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}${name}-keyboard.png` });
  const kb = await page.evaluate(() => {
    const f = document.querySelector('form')?.getBoundingClientRect();
    const t = document.querySelector('textarea')?.getBoundingClientRect();
    const w = document.querySelector('[data-wave]')?.getBoundingClientRect();
    return f && t && w
      ? { inside: f.right <= innerWidth + 1 && f.left >= -1, box: t.width, gap: f.top - w.bottom }
      : null;
  });
  if (!kb?.inside || (kb?.gap ?? -1) < -1 || (kb?.box ?? 0) < width * 0.6)
    errors.push(`${name} keyboard row does not fit: ${JSON.stringify(kb)}`);
  await page.close();
}
await browser.close();
console.log(errors.length ? `[FAIL]\n${errors.join('\n')}` : '[OK] zero console errors');
process.exitCode = errors.length ? 1 : 0;
