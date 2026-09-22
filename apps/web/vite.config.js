import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_PROXY_TARGET || 'http://localhost:4000';

  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
    preview: {
      port: 5173,
    },
    build: {
      // Slightly raise the warn limit so the React+router base chunk doesn't
      // trigger noise after we've already split out the heaviest deps.
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        output: {
          /**
           * Manual vendor chunks.
           *
           * Goal: keep the **initial** dashboard bundle as small as possible
           * by ensuring chart libraries, the script editor, and feature
           * routes are each in their own deferred chunk.
           *
           * Returning `undefined` lets Rollup keep its default behaviour
           * for everything else (including the user code, which gets split
           * automatically by the dynamic `import()` calls in App.jsx).
           */
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;

            // Charts (recharts + d3) — only loaded by RunReport behind Suspense.
            if (
              id.includes('node_modules/recharts') ||
              id.includes('node_modules/victory-vendor') ||
              /node_modules\/d3-/.test(id) ||
              id.includes('node_modules/internmap') ||
              id.includes('node_modules/decimal.js-light') ||
              id.includes('node_modules/react-smooth') ||
              id.includes('node_modules/react-transition-group') ||
              id.includes('node_modules/recharts-scale')
            ) {
              return 'vendor-charts';
            }

            // Routing.
            if (
              id.includes('node_modules/react-router') ||
              id.includes('node_modules/@remix-run/router') ||
              id.includes('node_modules/history')
            ) {
              return 'vendor-router';
            }

            // React core. Pinning these together prevents accidental
            // duplication across other chunks.
            if (
              id.includes('node_modules/react/') ||
              id.includes('node_modules/react-dom/') ||
              id.includes('node_modules/scheduler/') ||
              id.includes('node_modules/object-assign/')
            ) {
              return 'vendor-react';
            }

            // Everything else from npm.
            return 'vendor';
          },
        },
      },
    },
  };
});
