$ErrorActionPreference = 'Stop'
$origen = Split-Path -Parent $MyInvocation.MyCommand.Path
$destino = Join-Path $env:USERPROFILE 'MisFinanzas'
Write-Host ''
Write-Host '=== Instalación de Mis Finanzas ===' -ForegroundColor Cyan
Write-Host ''

# 1. Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host 'Falta instalar Node.js (es gratis).' -ForegroundColor Yellow
  Write-Host 'Se abrirá la página de descarga: elige la versión "LTS" para Windows, instálala y vuelve a abrir INSTALAR.bat.'
  Start-Process 'https://nodejs.org/es/download'
  exit 1
}
$ver = (& node -p "process.versions.node").Trim()
$p = $ver.Split('.') | ForEach-Object { [int]$_ }
if ($p[0] -lt 22 -or ($p[0] -eq 22 -and $p[1] -lt 13)) {
  Write-Host "Tu Node.js ($ver) es muy viejo. Instala la versión LTS más reciente desde nodejs.org y vuelve a abrir INSTALAR.bat." -ForegroundColor Yellow
  Start-Process 'https://nodejs.org/es/download'
  exit 1
}
Write-Host "[OK] Node.js $ver" -ForegroundColor Green

# 2. Detener una versión anterior si está funcionando
if (Test-Path (Join-Path $destino 'detener.ps1')) { & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $destino 'detener.ps1') | Out-Null }

# 3. Copiar archivos (nunca toca los datos ni los respaldos)
$actualizacion = Test-Path (Join-Path $destino 'datos\finanzas.db')
if ($origen.TrimEnd('\') -ne $destino.TrimEnd('\')) {
  New-Item -ItemType Directory -Force -Path $destino | Out-Null
  $excluir = @('datos', 'respaldos')
  Get-ChildItem -Path $origen -Force | Where-Object { $excluir -notcontains $_.Name } | ForEach-Object {
    $dst = Join-Path $destino $_.Name
    if ($_.Name -eq 'config.json' -and (Test-Path $dst)) { return }
    Copy-Item -Path $_.FullName -Destination $dst -Recurse -Force
  }
}
if ($actualizacion) { Write-Host "[OK] Mis Finanzas actualizado en $destino (tus datos se conservaron)" -ForegroundColor Green }
else { Write-Host "[OK] Mis Finanzas instalado en $destino" -ForegroundColor Green }

# 4. Revisar si los sistemas de los negocios están en esta computadora
foreach ($s in @(@('Casa de la Birria', 'SistemaRestaurante\datos\restaurante.db'), @('Vikingos Licor Store', 'SistemaVikingos\datos\vikingos.db'))) {
  if (Test-Path (Join-Path $env:USERPROFILE $s[1])) { Write-Host ("[OK] Enlazado con " + $s[0]) -ForegroundColor Green }
  else { Write-Host ("[!] No se encontró el sistema de " + $s[0] + " en esta computadora (puedes indicar dónde está en Ajustes)") -ForegroundColor Yellow }
}

# 5. Accesos directos
$ws = New-Object -ComObject WScript.Shell
$escritorio = [Environment]::GetFolderPath('Desktop')
$lnk = $ws.CreateShortcut((Join-Path $escritorio 'Mis Finanzas.lnk'))
$lnk.TargetPath = "$env:SystemRoot\System32\wscript.exe"
$lnk.Arguments = '"' + (Join-Path $destino 'iniciar.vbs') + '"'
$lnk.WorkingDirectory = $destino
$lnk.IconLocation = "$env:SystemRoot\System32\shell32.dll,43"
$lnk.Description = 'Control personal de ingresos, egresos y cuentas por pagar'
$lnk.Save()
Write-Host '[OK] Acceso directo "Mis Finanzas" en el escritorio' -ForegroundColor Green

$inicio = [Environment]::GetFolderPath('Startup')
$lnk2 = $ws.CreateShortcut((Join-Path $inicio 'Mis Finanzas (servidor).lnk'))
$lnk2.TargetPath = "$env:SystemRoot\System32\wscript.exe"
$lnk2.Arguments = '"' + (Join-Path $destino 'servidor.vbs') + '"'
$lnk2.WorkingDirectory = $destino
$lnk2.Save()
Write-Host '[OK] Se preparará solo al encender la computadora (para actualizarse y respaldar)' -ForegroundColor Green

Write-Host ''
Write-Host 'Abriendo Mis Finanzas...' -ForegroundColor Cyan
Start-Process "$env:SystemRoot\System32\wscript.exe" -ArgumentList ('"' + (Join-Path $destino 'iniciar.vbs') + '"')
Write-Host ''
Write-Host 'Listo. De ahora en adelante ábrelo con el icono "Mis Finanzas" del escritorio.' -ForegroundColor Green
