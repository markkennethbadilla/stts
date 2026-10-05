// e2e: the built daemon on STTS_TEST_PORT with its own data and profile dir, driven by a
// headless Chromium with fake media. Locally the shared headless shell (rule 77) is used.
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

export const testPort = Number(process.env['STTS_TEST_PORT'] ?? 15990);
export const dataRoot = join(import.meta.dirname, 'test-results', 'e2e-data');

export default defineConfig({
  testDir: 'test/e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${testPort}`,
    permissions: ['microphone'],
    launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  },
  webServer: {
    command: 'npm run build && node dist/daemon.js',
    url: `http://127.0.0.1:${testPort}/api/ping`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      STTS_PORT: String(testPort),
      STTS_PIPER_PORT: String(testPort + 1),
      STTS_PIPER_HOME: join(dataRoot, 'no-piper'),
      LOCALAPPDATA: dataRoot,
      HOME: dataRoot,
    },
  },
});
