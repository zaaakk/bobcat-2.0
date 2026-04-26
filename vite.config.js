import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    fs: { strict: false }
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 4096
  },
  assetsInclude: ['**/*.tif', '**/*.glb', '**/*.hdr']
});
