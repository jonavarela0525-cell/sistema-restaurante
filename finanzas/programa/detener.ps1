$aqui = Split-Path -Parent $MyInvocation.MyCommand.Path
$puerto = 8090
try { $puerto = (Get-Content (Join-Path $aqui 'config.json') -Raw | ConvertFrom-Json).puerto } catch {}
$encontrados = 0
# solo los procesos de ESTA carpeta (no toca los sistemas de los negocios)
$lanz = Join-Path $aqui 'lanzador.js'
$serv = Join-Path $aqui 'server.js'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($lanz) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $encontrados++ }
$ids = @()
$ids += Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($serv) } | ForEach-Object { $_.ProcessId }
$ids += Get-NetTCPConnection -LocalPort $puerto -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess }
$ids = $ids | Where-Object { $_ } | Sort-Object -Unique | Where-Object { (Get-Process -Id $_ -ErrorAction SilentlyContinue).ProcessName -eq 'node' }
foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue; $encontrados++ }
if ($encontrados -eq 0) { Write-Host "Mis Finanzas no estaba funcionando." -ForegroundColor Yellow; exit }
Start-Sleep -Seconds 1
Write-Host "Mis Finanzas detenido. Los datos están guardados." -ForegroundColor Green
