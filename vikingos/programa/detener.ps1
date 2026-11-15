$aqui = Split-Path -Parent $MyInvocation.MyCommand.Path
$puerto = 8081
try { $puerto = (Get-Content (Join-Path $aqui 'config.json') -Raw | ConvertFrom-Json).puerto } catch {}
$encontrados = 0
# 1) primero el lanzador, para que no vuelva a abrir el servidor
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*lanzador.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $encontrados++ }
# 2) el servidor, por linea de comandos y por el puerto
$ids = @()
$ids += Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { $_.ProcessId }
$ids += Get-NetTCPConnection -LocalPort $puerto -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess }
$ids = $ids | Where-Object { $_ } | Sort-Object -Unique | Where-Object { (Get-Process -Id $_ -ErrorAction SilentlyContinue).ProcessName -eq 'node' }
foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue; $encontrados++ }
if ($encontrados -eq 0) { Write-Host "El sistema no estaba funcionando." -ForegroundColor Yellow; exit }
Start-Sleep -Seconds 1
Write-Host "Sistema detenido. Los datos estan guardados." -ForegroundColor Green
