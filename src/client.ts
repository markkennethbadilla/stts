// Typed fetch to the daemon: ping first, retire a daemon from another install, one retry.
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, REQUEST_TIMEOUT_MS, type RequestBody } from './protocol.ts';

export const daemonUrl = (port: number = Number(process.env['STTS_PORT'] ?? DEFAULT_PORT)): string =>
  `http://127.0.0.1:${port}`;

export const ourDir = dirname(fileURLToPath(import.meta.url));
const budgetMs = (): number => Number(process.env['STTS_REQUEST_TIMEOUT_MS'] ?? REQUEST_TIMEOUT_MS);
const DAEMON_GONE = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE']);

export const daemonGone = (e: unknown): boolean => {
  const err = e as { cause?: { code?: unknown }; code?: unknown } | undefined;
  const code = err?.cause?.code ?? err?.code;
  return typeof code === 'string' && DAEMON_GONE.has(code);
};

export function spawnDaemon(): void {
  spawn(process.execPath, [fileURLToPath(new URL('./daemon.js', import.meta.url))], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
}

// ours: this install. stale: another install, no window open. busy: another install mid-conversation.
export async function ping(): Promise<'ours' | 'stale' | 'busy' | 'down'> {
  let res: Response;
  try {
    res = await fetch(`${daemonUrl()}/api/ping`, { signal: AbortSignal.timeout(2000) });
  } catch {
    return 'down';
  }
  if (res.headers.get('X-Stts-Dir') === ourDir) return 'ours';
  try {
    const barge = await fetch(`${daemonUrl()}/barge`, { signal: AbortSignal.timeout(2000) });
    if (((await barge.json()) as { open?: boolean }).open) return 'busy';
  } catch {}
  return 'stale';
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Make sure a daemon answers. A stale one with a window open keeps serving until it ends.
export async function ensureDaemon(): Promise<void> {
  const s = await ping();
  if (s === 'ours' || s === 'busy') return;
  if (s === 'stale') {
    await fetch(`${daemonUrl()}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) }).catch(() => {});
  }
  spawnDaemon();
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    const now = await ping();
    if (now === 'ours' || now === 'busy') return;
  }
  throw new Error('stts daemon did not start');
}

async function post(body: RequestBody): Promise<string> {
  const res = await fetch(`${daemonUrl()}/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(budgetMs() + 5000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`stts daemon returned ${res.status}: ${text}`);
  return text;
}

// On ECONNRESET, ECONNREFUSED or EPIPE the daemon is respawned and the request sent once more.
export async function request(body: RequestBody): Promise<string> {
  await ensureDaemon();
  try {
    return await post(body);
  } catch (e) {
    if (!daemonGone(e)) throw e;
    await ensureDaemon();
    return await post(body);
  }
}
