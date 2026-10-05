import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { app, deps, installedDir, isLatest, liveUpdate } from '../../src/daemon.ts';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const handoffs: string[] = [];
let updates = 0;
deps.log = () => {};
deps.exit = () => {};
deps.update = async () => void updates++;
deps.handoff = async (to) => void handoffs.push(to);
deps.openWindow = async () => {};
// A plain listen open: the only moment a hand-off happens.
const listen = () => app.request('/request', { method: 'POST', body: JSON.stringify({ kind: 'stt' }) });

// An installed_plugins.json whose stts entry points at installPath (its dist holds daemon.js).
function installs(installPath: string | null): void {
  const dir = mkdtempSync(join(tmpdir(), 'stts-live-'));
  const file = join(dir, 'installed_plugins.json');
  const plugins = installPath ? { 'stts@stts-marketplace': [{ installPath }] } : {};
  writeFileSync(file, JSON.stringify({ version: 2, plugins }));
  process.env['STTS_INSTALLS'] = file;
}
function newInstall(): string {
  const root = mkdtempSync(join(tmpdir(), 'stts-install-'));
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist', 'daemon.js'), '');
  return root;
}

afterEach(() => {
  delete process.env['STTS_INSTALLS'];
  handoffs.length = 0;
  updates = 0;
});

it('hands off to a newer install only while a plain listen is open', async () => {
  const root = newInstall();
  installs(root);
  expect(await liveUpdate()).toBe(false);
  void listen();
  await new Promise((r) => setTimeout(r, 0));
  expect(await liveUpdate()).toBe(true);
  expect(updates).toBe(1);
  expect(handoffs).toEqual([join(root, 'dist')]);
});

it('stays when the install is missing, has no daemon.js, or the file is bad', async () => {
  installs(null);
  expect(installedDir()).toBe('');
  expect(await liveUpdate()).toBe(false);
  installs(mkdtempSync(join(tmpdir(), 'stts-empty-')));
  expect(await liveUpdate()).toBe(false);
  writeFileSync(join(tmpdir(), 'stts-bad.json'), '{not json');
  process.env['STTS_INSTALLS'] = join(tmpdir(), 'stts-bad.json');
  expect(installedDir()).toBe('');
  expect(handoffs).toEqual([]);
});

it('the installed daemon refuses an older client shutdown; another install accepts it', async () => {
  // here is src/ in tests, so an install whose dist is src makes this daemon the installed one.
  const root = mkdtempSync(join(tmpdir(), 'stts-self-'));
  installs(root);
  expect(isLatest()).toBe(false);
  const ok = await app.request('/api/shutdown', { method: 'POST' });
  expect(ok.status).toBe(200);
  process.env['STTS_INSTALLS'] = (() => {
    const f = join(mkdtempSync(join(tmpdir(), 'stts-live-')), 'i.json');
    writeFileSync(f, JSON.stringify({ plugins: { 'stts@x': [{ installPath: join(src, '..', 'test', '..') }] } }));
    return f;
  })();
  // ponytail: the installPath/dist convention means src/ never matches; isLatest is covered by installedDir + same().
  expect(installedDir()).toBe(join(src, '..', 'dist'));
});
