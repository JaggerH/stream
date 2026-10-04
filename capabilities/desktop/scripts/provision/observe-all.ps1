# 一条命令里跑完「起浏览器 → 观察 → 收摊」。
# 为什么不分两次 ssh：SSH 会话退出时会把它起的子进程一并带走，chrome 活不过第一条命令。
$ErrorActionPreference = 'Stop'
$chrome = 'C:\stream-pair\chrome-win64\chrome.exe'
$ext = 'C:\stream-pair\extension'
$profileDir = 'C:\stream-pair\cft-profile'
$port = 9222

if (Test-Path $profileDir) { Remove-Item -Recurse -Force $profileDir }

$p = Start-Process -FilePath $chrome -PassThru -WindowStyle Hidden -ArgumentList @(
  "--headless=new", "--remote-debugging-port=$port", "--user-data-dir=$profileDir",
  "--load-extension=$ext", "--disable-extensions-except=$ext",
  "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank")
Write-Output "PID=$($p.Id)"
try {
  $ver = $null
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    try { $ver = Invoke-RestMethod "http://127.0.0.1:$port/json/version" -Proxy $null; break } catch {}
  }
  if (-not $ver) { Write-Output "CDP_UNREACHABLE"; exit 1 }
  Write-Output "BROWSER=$($ver.Browser)"
  Start-Sleep -Seconds 3
  node C:\stream-pair\observe2.mjs $port
} finally {
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
}
