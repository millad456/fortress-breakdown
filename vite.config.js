import { defineConfig } from 'vite';

// Relative base so the build works on GitHub Pages (project subpath) and any static host.
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    open: false,
  },
});
