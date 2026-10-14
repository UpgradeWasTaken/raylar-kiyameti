import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Relative base so the build works at https://<user>.github.io/<repo>/ without configuration.
export default defineConfig({
  base: './',
  plugins: [preact()],
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});
