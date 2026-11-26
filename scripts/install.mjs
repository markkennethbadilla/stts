#!/usr/bin/env node
// Installs the local Piper voice (spec 014): a Python venv with piper-tts and the pinned voice files.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const win = process.platform === 'win32';
const pins = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'install.json'), 'utf8'));
export const dataDir =
  process.env['STTS_DATA_DIR'] ??
  (win ? join(process.env['LOCALAPPDATA'] ?? homedir(), 'stts') : join(homedir(), '.local', 'share', 'stts'));
const fromConfig = () => {
  try {
    return JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')).modelsDir;
  } catch {
    // SILENT-OK: no config.json means the default models folder
    return undefined;
  }
};
export const modelsDir = process.env['STTS_MODELS_DIR'] ?? fromConfig() ?? join(dataDir, 'models');
const piperHome = process.env['STTS_PIPER_HOME'] ?? join(dataDir, 'piper');
const venvPy = join(piperHome, 'venv', win ? 'Scripts/python.exe' : 'bin/python');
const voiceDir = join(modelsDir, pins.voice.dir);

const say = (step, msg) => console.log(`${step} install ${msg}`);
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });

export function missing() {
  const out = [];
  if (!existsSync(venvPy)) out.push('python venv');
  for (const f of Object.keys(pins.voice.files)) if (!existsSync(join(voiceDir, f))) out.push(join(voiceDir, f));
  return out;
}

function findPython() {
  const tries = win
    ? [
        ['py', ['-3']],
        ['python', []],
      ]
    : [
        ['python3', []],
        ['python', []],
      ];
  for (const [cmd, pre] of tries) {
    const r = run(cmd, [...pre, '-c', 'import sys; print(sys.version_info >= (3, 10))']);
    if (r.status === 0 && r.stdout.trim() === 'True') return [cmd, pre];
  }
  return null;
}

async function fetchFile(url, dest, sha) {
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const hash = createHash('sha256');
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => hash.update(c));
  await pipeline(body, createWriteStream(part));
  const got = hash.digest('hex');
  if (got !== sha) throw new Error(`${url}: SHA256 ${got}, pinned ${sha}`);
  renameSync(part, dest);
}

export async function install() {
  let failed = 0;
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      failed++;
      say('FAIL', `${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  say('START', `data ${dataDir}, models ${modelsDir}`);
  await step('python venv', () => {
    const want = Object.entries(pins.python).map(([p, v]) => `${p}==${v}`);
    if (!existsSync(venvPy)) {
      const py = findPython();
      if (!py) throw new Error('Python 3.10 or newer is needed on PATH (python.org), then restart the agent');
      const r = run(py[0], [...py[1], '-m', 'venv', join(piperHome, 'venv')]);
      if (r.status !== 0) throw new Error(`venv: ${r.stderr.trim()}`);
    }
    const have = run(venvPy, ['-m', 'pip', 'list', '--format=freeze']).stdout ?? '';
    const need = want.filter((w) => !have.includes(w.replace('[http]', '')));
    if (need.length) {
      say('START', `pip install ${need.join(' ')}`);
      const r = run(venvPy, ['-m', 'pip', 'install', '-q', ...need]);
      if (r.status !== 0) throw new Error(`pip: ${r.stderr.trim().split('\n').pop()}`);
    }
    say('OK', want.join(' '));
  });
  await step('voice', async () => {
    for (const [name, sha] of Object.entries(pins.voice.files)) {
      const dest = join(voiceDir, name);
      if (existsSync(dest)) continue;
      say('START', `${name} into ${voiceDir}`);
      await fetchFile(`${pins.voice.source}/${name}`, dest, sha);
      say('OK', name);
    }
  });
  say(failed ? 'FAIL' : 'OK', failed ? `${failed} step(s) failed` : 'every part in place');
  return failed === 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--check')) {
    const m = missing();
    console.log(m.length ? `missing: ${m.join(', ')}` : 'nothing missing');
    process.exit(m.length ? 1 : 0);
  }
  process.exit((await install()) ? 0 : 1);
}
