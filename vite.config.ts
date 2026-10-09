import { defineConfig } from 'vite';

// Relative base so the build works from any GitHub Pages sub-path (user.github.io/<repo>/).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
