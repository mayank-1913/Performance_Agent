import http from 'k6/http';
export const options = { vus: 1, iterations: 1 };
export default function () {
  const res = http.get('http://127.0.0.1:9876/slow-200', { timeout: '10s' });
  console.log('${pathname} status=' + res.status + ' dur=' + res.timings.duration + ' err=' + res.error);
}