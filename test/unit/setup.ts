import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';

// Each test file gets its own data folder (files run in parallel), and each test starts with no
// End conversation remembered. Never Mark's real folder: a test's End would end his conversation.
const data = join(tmpdir(), `stts-unit-${process.pid}`);
process.env['LOCALAPPDATA'] = data;
process.env['HOME'] = data;
const clear = () => rmSync(join(data, 'cc-gc-stts', 'ended'), { force: true });
beforeEach(clear);
afterEach(clear);
