import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/daemon.ts', 'src/mcp.ts'],
  outDir: 'dist',
  platform: 'node',
  format: 'esm',
  fixedExtension: false,
  // The earcons sit next to dist/daemon.js, where its /earcon route serves them.
  copy: [{ from: 'public/earcon/*.ogg', to: 'dist/earcon' }],
});
