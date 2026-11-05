import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './app/App.jsx';
import './index.css';

// Keep the router's internal paths aligned with Vite's base path. In the
// production build this is `/perf-agent/` (deploy-gateway mount); in local
// dev it's `/`. Without this, a navigation to `/login` would overwrite the
// `/perf-agent` prefix in the address bar and break both the deep-link and
// every API call that assumes the gateway mount.
const basename = (import.meta.env.BASE_URL || '/').replace(/\/$/, '') || '/';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter basename={basename}>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
