// Vite bakes the resolved base path into `import.meta.env.BASE_URL` — it is
// `/perf-agent/` in the production build (apps/web/Dockerfile ARG) and `/`
// in local dev. Prefixing the API client with BASE_URL ensures `/api/v1/*`
// requests hit `/perf-agent/api/v1/*` under the gateway, while
// `localhost:5173` keeps hitting `/api/v1/*` directly (handled by the Vite
// dev proxy in vite.config.js). `VITE_API_BASE_URL` is still honored as an
// explicit override for unusual setups.
const BASE = import.meta.env.BASE_URL || '/';
// BASE already ends with '/', so just concatenate without a leading slash.
const DEFAULT_API = `${BASE}api/v1`.replace(/\/{2,}/g, '/');

export const config = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL || DEFAULT_API,
  appName: 'Performance Agent',
};
