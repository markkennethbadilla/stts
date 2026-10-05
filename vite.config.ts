import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./web', import.meta.url)) } },
  // public/ is copied by tsdown (earcons to dist/earcon, icons to dist/web).
  publicDir: false,
  // tsdown cleans dist first and copies the icons in; Vite must not wipe them.
  build: { outDir: 'dist/web', emptyOutDir: false },
});
