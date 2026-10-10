import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

/** Hash of every audio source file: the rendered-sound cache is only reused while this matches. */
function soundVersion() {
  const dir = new URL('./src/audio/', import.meta.url);
  const h = createHash('sha256');
  for (const f of readdirSync(dir).sort()) h.update(f).update(readFileSync(new URL(f, dir)));
  return h.digest('hex').slice(0, 16);
}

// Relative base so the build works from any GitHub Pages sub-path (user.github.io/<repo>/).
export default defineConfig({
  base: './',
  define: {
    __SOUND_VERSION__: JSON.stringify(soundVersion()),
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // three.js in its own file: it rarely changes, so returning players keep it cached across deploys
        manualChunks: (id) => (id.includes('/node_modules/three/') ? 'three' : undefined),
      },
    },
  },
});
