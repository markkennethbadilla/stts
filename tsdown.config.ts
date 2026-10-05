import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/daemon.ts', 'src/mcp.ts'],
  outDir: 'dist',
  platform: 'node',
  format: 'esm',
});
