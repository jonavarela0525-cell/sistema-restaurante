$ErrorActionPreference = 'Stop'
$origen = Split-Path -Parent $MyInvocation.MyCommand.Path
$destino = Join-Path $env:USERPROFILE 'SistemaVikingos'
Write-Host ''
Write-Host '=== Instalación del Sistema Vikingos ===' -ForegroundColor Cyan
Write-Host ''

# 1. Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host 'Falta instalar Node.js (es gratis).' -ForegroundColor Yellow
  Write-Host 'Se abrirá la página de descarga: elige la versión "LTS" para Windows, instálala con las opciones normales y luego vuelve a abrir INSTALAR.bat.'
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

# 3. Copiar archivos (nunca toca los datos ni los respaldos existentes)
$actualizacion = Test-Path (Join-Path $destino 'datos\vikingos.db')
if ($origen.TrimEnd('\') -ne $destino.TrimEnd('\')) {
  New-Item -ItemType Directory -Force -Path $destino | Out-Null
  $excluir = @('datos', 'respaldos')
  Get-ChildItem -Path $origen -Force | Where-Object { $excluir -notcontains $_.Name } | ForEach-Object {
    $dst = Join-Path $destino $_.Name
    if ($_.Name -eq 'config.json' -and (Test-Path $dst)) { return }
    if ($_.Name -eq 'importar.json' -and $actualizacion) { return }
    Copy-Item -Path $_.FullName -Destination $dst -Recurse -Force
  }
}
if ($actualizacion) { Write-Host "[OK] Sistema actualizado en $destino (tus datos se conservaron)" -ForegroundColor Green }
else { Write-Host "[OK] Sistema instalado en $destino" -ForegroundColor Green }

# 4. Accesos directos
$ws = New-Object -ComObject WScript.Shell
$escritorio = [Environment]::GetFolderPath('Desktop')
$lnk = $ws.CreateShortcut((Join-Path $escritorio 'Vikingos Licor Store.lnk'))
$lnk.TargetPath = "$env:SystemRoot\System32\wscript.exe"
$lnk.Arguments = '"' + (Join-Path $destino 'iniciar.vbs') + '"'
$lnk.WorkingDirectory = $destino
$lnk.IconLocation = (Join-Path $destino 'vikingos.ico')
$lnk.Description = 'Facturación e inventario de Vikingos Licor Store'
$lnk.Save()
Write-Host '[OK] Acceso directo "Vikingos Licor Store" en el escritorio' -ForegroundColor Green

$inicio = [Environment]::GetFolderPath('Startup')
$lnk2 = $ws.CreateShortcut((Join-Path $inicio 'Vikingos Licor Store (servidor).lnk'))
$lnk2.TargetPath = "$env:SystemRoot\System32\wscript.exe"
$lnk2.Arguments = '"' + (Join-Path $destino 'servidor.vbs') + '"'
$lnk2.WorkingDirectory = $destino
$lnk2.Save()
Write-Host '[OK] El sistema arrancará solo al encender la computadora' -ForegroundColor Green

# 5. Permiso de red para celulares (pide confirmación de administrador)
$puerto = 8081
try { $puerto = (Get-Content (Join-Path $destino 'config.json') -Raw | ConvertFrom-Json).puerto } catch {}
Write-Host ''
Write-Host 'Windows te pedirá permiso para que los celulares puedan conectarse por WiFi. Responde "Sí".' -ForegroundColor Yellow
try {
  $cmd = "/c netsh advfirewall firewall delete rule name=""Vikingos Licor Store"" >nul 2>&1 & netsh advfirewall firewall add rule name=""Vikingos Licor Store"" dir=in action=allow protocol=TCP localport=$puerto profile=any"
  Start-Process cmd.exe -ArgumentList $cmd -Verb RunAs -Wait -WindowStyle Hidden
  Write-Host '[OK] Permiso de red configurado' -ForegroundColor Green
} catch {
  Write-Host '[!] No se configuró el permiso de red. Los celulares podrían no conectarse. Vuelve a abrir INSTALAR.bat y responde "Sí".' -ForegroundColor Yellow
}

# 6. Que la computadora no se duerma estando conectada a la corriente
try { powercfg /change standby-timeout-ac 0 | Out-Null; Write-Host '[OK] La computadora no se suspenderá mientras esté conectada a la corriente' -ForegroundColor Green } catch {}

Write-Host ''
Write-Host 'Abriendo el sistema...' -ForegroundColor Cyan
Start-Process "$env:SystemRoot\System32\wscript.exe" -ArgumentList ('"' + (Join-Path $destino 'iniciar.vbs') + '"')
Write-Host ''
Write-Host 'Listo. De ahora en adelante abre el sistema con el icono "Vikingos Licor Store" del escritorio.' -ForegroundColor Green
