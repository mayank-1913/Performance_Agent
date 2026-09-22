$dir = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ('probe4-' + (Get-Random))) -Force
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
  if (__ENV.SUMMARY_EXPORT_PATH) out[__ENV.SUMMARY_EXPORT_PATH] = JSON.stringify(clean);
  return out;
}
'@
Set-Content -Path (Join-Path $dir.FullName 'probe.js') -Value $scriptSrc -Encoding utf8
Set-Location $dir.FullName
k6 run --quiet -e "SUMMARY_EXPORT_PATH=$sumPath" probe.js 2>&1 | Out-Null
$c = Get-Content $sumPath -Raw
Write-Output ("size=" + (Get-Item $sumPath).Length)
Write-Output ("leak=" + $c.Contains('PROBE_LEAK_TOKEN_ABC'))
Write-Output ("has_setup_data=" + $c.Contains('setup_data'))
$j = $c | ConvertFrom-Json
Write-Output "top-level keys:"; $j.PSObject.Properties.Name | ForEach-Object { Write-Output ("  " + $_) }
Write-Output "metrics keys:"; $j.metrics.PSObject.Properties.Name | ForEach-Object { Write-Output ("  " + $_) }