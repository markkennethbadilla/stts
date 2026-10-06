import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// The daemon's data folder points at a temp folder: a test's End must never end Mark's real
// conversation (the ended flag lives in the data folder).
const data = join(tmpdir(), 'stts-unit');
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    setupFiles: ['test/unit/setup.ts'],
    env: { LOCALAPPDATA: data, HOME: data },
  },
});
