import { defineConfig, type UserConfig } from 'tsdown';

// `claude plugin install` copies the repo without node_modules, so every
// runtime dependency is bundled in; only node builtins stay external.
// One build per entry, so each file is self-contained (no shared chunk).
const base: UserConfig = {
  outDir: 'dist',
  platform: 'node',
  target: 'node20',
  format: 'esm',
  fixedExtension: false,
  shims: true,
  deps: { alwaysBundle: [/.*/] },
};

export default defineConfig([
  { ...base, entry: ['src/mcp.ts'] },
  {
    ...base,
    entry: ['src/daemon.ts'],
    clean: false,
    copy: [
      // The earcons sit next to dist/daemon.js, where its /earcon route serves them.
      { from: 'public/earcon/*.ogg', to: 'dist/earcon' },
      // Icons and manifest go beside dist/web/index.html (Vite keeps them: emptyOutDir false).
      { from: 'public/*.{ico,svg,png,webmanifest}', to: 'dist/web' },
    ],
  },
]);
