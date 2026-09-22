import { useEffect, useRef, useState } from 'react';
import { runsApi } from '../../shared/api/runs.api.js';

/**
 * Subscribe to a run's SSE stream.
 * Returns { status, lines, summary, error } reactive state.
 */
export function useRunStream(runId) {
  const [status, setStatus] = useState(null);
  const [lines, setLines] = useState([]);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const sourceRef = useRef(null);

  useEffect(() => {
    if (!runId) return;
    setLines([]);
    setStatus(null);
    setSummary(null);
    setError(null);

    const url = runsApi.streamUrl(runId);
    const es = new EventSource(url, { withCredentials: false });
    sourceRef.current = es;

    es.addEventListener('status', (e) => {
      try {
        const data = JSON.parse(e.data);
        setStatus(data);
      } catch {
        /* ignore */
      }
    });

    es.addEventListener('log', (e) => {
      try {
        const data = JSON.parse(e.data);
        setLines((prev) => {
          // Keep the buffer bounded on the client too
          const next = prev.concat(data);
          return next.length > 5000 ? next.slice(-5000) : next;
        });
      } catch {
        /* ignore */
      }
    });

    es.addEventListener('summary', (e) => {
      try {
        const data = JSON.parse(e.data);
        setSummary(data.summary);
      } catch {
        /* ignore */
      }
    });

    es.addEventListener('done', (e) => {
      try {
        const data = JSON.parse(e.data);
        setStatus(data);
      } catch {
        /* ignore */
      }
      es.close();
    });

    es.onerror = () => {
      // EventSource auto-reconnects; surface a soft warning only on terminal errors
      if (es.readyState === EventSource.CLOSED) {
        setError('Stream closed.');
      }
    };

    return () => {
      es.close();
      sourceRef.current = null;
    };
  }, [runId]);

  return { status, lines, summary, error };
}
