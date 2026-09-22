import { useEffect, useState } from 'react';
import { healthApi } from '../api/health.api.js';

export default function HealthBadge() {
  const [status, setStatus] = useState('checking');
  const [info, setInfo] = useState(null);

  useEffect(() => {
    let mounted = true;
    const check = async () => {
      try {
        const data = await healthApi.check();
        if (!mounted) return;
        setStatus('ok');
        setInfo(data);
      } catch {
        if (!mounted) return;
        setStatus('down');
        setInfo(null);
      }
    };
    check();
    const id = setInterval(check, 15000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  const dot =
    status === 'ok'
      ? 'bg-emerald-400'
      : status === 'down'
      ? 'bg-rose-400'
      : 'bg-amber-400';

  const label =
    status === 'ok' ? 'API healthy' : status === 'down' ? 'API offline' : 'Checking…';

  return (
    <div className="flex items-center gap-2 text-[11px] text-soft">
      <span className={`status-dot ${dot}`} />
      <span>{label}</span>
      {info?.uptimeSec != null && (
        <span className="text-muted">· {info.uptimeSec}s</span>
      )}
    </div>
  );
}
