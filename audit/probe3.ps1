$dir = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ('probe3-' + (Get-Random))) -Force
$sumPath = Join-Path $dir.FullName 'summary.json'
$scriptSrc = @'
import http from 'k6/http';
import { sleep } from 'k6';
export const options = { vus: 1, duration: '1s' };
export function setup() { return { ACCESS_TOKEN: 'PROBE_LEAK_TOKEN_ABC' }; }
export default function (data) { http.get('http://127.0.0.1:65535/'); sleep(0.1); }
export function handleSummary(data) {
  const clean = Object.assign({}, data); delete clean.setup_data;
  const out = {};
  out[__ENV.SUM_PATH] = JSON.stringify(clean);
  return out;
}
'@
Set-Content -Path (Join-Path $dir.FullName 'probe.js') -Value $scriptSrc -Encoding utf8
Set-Location $dir.FullName
Write-Output "test A: no --summary-export, handleSummary writes to SUM_PATH"
k6 run --quiet -e "SUM_PATH=$sumPath" probe.js 2>&1 | Out-Null
if (Test-Path $sumPath) {
  $c = Get-Content $sumPath -Raw
  Write-Output ("  size=" + (Get-Item $sumPath).Length + " leak=" + $c.Contains('PROBE_LEAK_TOKEN_ABC') + " has_setup_data=" + $c.Contains('setup_data'))
} else { Write-Output "  NO FILE" }
Remove-Item $sumPath -Force -ErrorAction SilentlyContinue
Write-Output "test B: --summary-export=path AND handleSummary returns same absolute path"
k6 run --quiet --summary-export "$sumPath" -e "SUM_PATH=$sumPath" probe.js 2>&1 | Out-Null
if (Test-Path $sumPath) {
  $c = Get-Content $sumPath -Raw
  Write-Output ("  size=" + (Get-Item $sumPath).Length + " leak=" + $c.Contains('PROBE_LEAK_TOKEN_ABC') + " has_setup_data=" + $c.Contains('setup_data'))
}