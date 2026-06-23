import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import fs from 'node:fs';

// Dev-only endpoint for the Debug Lab (/lab.html). The lab renders frames in the
// browser and POSTs them here as base64 PNGs; we decode and write them under
// ./lab_captures/ so they can be opened directly off disk. `apply:'serve'` keeps
// this out of production builds entirely.
function labCapturePlugin() {
  return {
    name: 'granny-lab-capture',
    apply: 'serve' as const,
    configureServer(server: any) {
      server.middlewares.use('/__lab_capture', (req: any, res: any) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return; }
        let body = '';
        req.on('data', (c: any) => { body += c; if (body.length > 64 * 1024 * 1024) req.destroy(); });
        req.on('end', () => {
          try {
            const { name, dataURL } = JSON.parse(body);
            const m = /^data:image\/png;base64,(.+)$/.exec(dataURL || '');
            if (!m) { res.statusCode = 400; res.end('bad dataURL'); return; }
            const safe = String(name || 'capture').replace(/[^a-z0-9_\-]/gi, '_').slice(0, 80) || 'capture';
            const dir = fileURLToPath(new URL('./lab_captures/', import.meta.url));
            fs.mkdirSync(dir, { recursive: true });
            const file = dir + safe + '.png';
            fs.writeFileSync(file, Buffer.from(m[1], 'base64'));
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, file }));
          } catch (e: any) {
            res.statusCode = 500; res.end(String(e && e.message || e));
          }
        });
      });
    },
  };
}

// Three.js ships its addons under examples/jsm but does NOT list them in its
// package "exports" map, so `three/addons/*` won't resolve through normal Node
// resolution. We alias it to an ABSOLUTE filesystem path, which bypasses the
// exports gate entirely. cannon-es resolves fine via its "module" field.
const jsm = fileURLToPath(new URL('./node_modules/three/examples/jsm/', import.meta.url));

const ADDONS = [
  'three/addons/postprocessing/EffectComposer.js',
  'three/addons/postprocessing/RenderPass.js',
  'three/addons/postprocessing/ShaderPass.js',
  'three/addons/postprocessing/OutputPass.js',
];

export default defineConfig({
  // Relative base => asset URLs are relative, so the build works on Vercel,
  // Netlify, GitHub Pages subpaths, or even opened from a file path.
  base: './',
  plugins: [labCapturePlugin()],
  resolve: {
    alias: [{ find: /^three\/addons\//, replacement: jsm }],
  },
  // Pre-bundle the heavy deps at server start so a cold first load never hits
  // the "module specifier" race (Vite re-optimizing deps mid-load).
  optimizeDeps: {
    include: ['three', 'cannon-es', ...ADDONS],
  },
  // Pin an inline (empty) PostCSS config so Vite does NOT walk up the directory
  // tree and pick up a parent project's postcss.config (which references
  // tailwindcss we don't have). This project uses plain CSS in index.html.
  css: { postcss: {} },
  build: {
    target: 'es2020',
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    sourcemap: false,
  },
  server: {
    host: true,
    strictPort: true,
  },
});
