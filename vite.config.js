import { defineConfig } from 'vite';

// `base` lets one build serve from a domain root (Vercel/Netlify/itch) or from
// a subpath (GitHub Pages project sites live at /<repo>/). Asset URLs go
// through src/assetPath.js, which reads it back as import.meta.env.BASE_URL.
// Set BASE_PATH at build time; dev and root-hosted builds need nothing.
export default defineConfig({
  base: process.env.BASE_PATH || '/',
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
