param([string]$Accion = 'imprimir', [string]$Impresora = '', [string]$Archivo = '')
# Sistema Vikingos: impresión directa (RAW / ESC-POS) en impresoras de Windows.
# Uso: imprimir.ps1 -Accion listar
#      imprimir.ps1 -Accion imprimir -Impresora "Nombre" -Archivo "ruta.bin"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if ($Accion -eq 'listar') {
  $lista = @(Get-CimInstance Win32_Printer | ForEach-Object { [pscustomobject]@{ nombre = $_.Name; predeterminada = [bool]$_.Default; puerto = $_.PortName; driver = $_.DriverName } })
  ConvertTo-Json -InputObject $lista -Compress
  exit 0
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class RawPrn {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", SetLastError = true)] public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern int StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);
  [DllImport("winspool.Drv", SetLastError = true)] public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", SetLastError = true)] public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", SetLastError = true)] public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", SetLastError = true)] public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);
  public static string Enviar(string impresora, byte[] datos) {
    IntPtr h;
    if (!OpenPrinter(impresora, out h, IntPtr.Zero)) return "No se pudo abrir la impresora '" + impresora + "' (error " + Marshal.GetLastWin32Error() + ")";
    try {
      DOCINFO di = new DOCINFO(); di.pDocName = "Vikingos Licor Store"; di.pDataType = "RAW";
      if (StartDocPrinter(h, 1, di) == 0) return "No se pudo iniciar la impresión (error " + Marshal.GetLastWin32Error() + ")";
      StartPagePrinter(h);
      IntPtr p = Marshal.AllocCoTaskMem(datos.Length);
      Marshal.Copy(datos, 0, p, datos.Length);
      int escritos;
      bool ok = WritePrinter(h, p, datos.Length, out escritos);
      Marshal.FreeCoTaskMem(p);
      EndPagePrinter(h); EndDocPrinter(h);
      if (!ok || escritos != datos.Length) return "No se pudo enviar a la impresora (error " + Marshal.GetLastWin32Error() + ")";
      return "OK";
    } finally { ClosePrinter(h); }
  }
}
"@

try {
  $bytes = [System.IO.File]::ReadAllBytes($Archivo)
  Write-Output ([RawPrn]::Enviar($Impresora, $bytes))
} catch {
  Write-Output ("Error: " + $_.Exception.Message)
}
