import http from 'k6/http';
import { sleep } from 'k6';

export const options = { vus: 1, duration: '1s' };

export function setup() {
  return { ACCESS_TOKEN: 'PROBE_LEAK_TOKEN_ABC', foo: 'bar' };
}

export default function (data) {
  http.get('http://127.0.0.1:65535/');
  sleep(0.1);
}

/*
 * Probe: return the SAME filename `--summary-export` writes to and see
 * whether handleSummary wins (either by overwriting after k6, or by
 * pre-empting the export write).
 */
export function handleSummary(data) {
  const clean = Object.assign({}, data);
  delete clean.setup_data;
  return {
    stdout: '[probe] handleSummary invoked; setup_data stripped\n',
    'summary-export.json': JSON.stringify(clean),
  };
}
