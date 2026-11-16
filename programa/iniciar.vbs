' Abre el Sistema del Restaurante (inicia el servidor si no esta funcionando)
Option Explicit
Dim sh, fso, dir, port, cfg, txt, re, m, http, i, ok, edge, url, remoto
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
port = "8080" : txt = ""
If fso.FileExists(dir & "\config.json") Then
  Set cfg = fso.OpenTextFile(dir & "\config.json", 1)
  txt = cfg.ReadAll : cfg.Close
  Set re = New RegExp : re.Pattern = """puerto""\s*:\s*(\d+)"
  Set m = re.Execute(txt)
  If m.Count > 0 Then port = m(0).SubMatches(0)
End If
url = "http://localhost:" & port
' Modo conectado: esta computadora usa el sistema de OTRA computadora (la del restaurante)
remoto = ""
If txt <> "" Then
  Set re = New RegExp : re.Pattern = """servidorRemoto""\s*:\s*""([^""]+)"""
  Set m = re.Execute(txt)
  If m.Count > 0 Then remoto = m(0).SubMatches(0)
End If
If remoto <> "" Then
  url = remoto
  If Left(LCase(url), 4) <> "http" Then url = "http://" & url
  If InStr(Mid(url, 8), ":") = 0 Then url = url & ":8080"
End If
If Not fso.FolderExists(dir & "\datos") Then fso.CreateFolder(dir & "\datos")

Function Responde()
  On Error Resume Next
  Dim h : Set h = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  h.setTimeouts 1000, 1000, 1000, 1000
  h.Open "GET", url & "/api/estado", False
  h.Send
  Responde = (Err.Number = 0 And h.Status = 200)
  On Error GoTo 0
End Function

If remoto <> "" Then
  If Not Responde() Then
    MsgBox "No se puede conectar con la computadora del restaurante (" & url & ")." & vbCrLf & vbCrLf & "Revisa que:" & vbCrLf & "- La computadora del restaurante este encendida con el sistema abierto." & vbCrLf & "- Tailscale este conectado en las dos computadoras." & vbCrLf & "- Esta computadora tenga internet.", 48, "Sistema del Restaurante"
    WScript.Quit 1
  End If
ElseIf Not Responde() Then
  sh.Run "cmd /c node """ & dir & "\lanzador.js"" >> """ & dir & "\datos\consola.log"" 2>&1", 0, False
  ok = False
  For i = 1 To 40
    WScript.Sleep 500
    If Responde() Then ok = True : Exit For
  Next
  If Not ok Then
    MsgBox "No se pudo iniciar el sistema." & vbCrLf & vbCrLf & "Revisa que Node.js este instalado y mira el archivo datos\consola.log", 16, "Sistema del Restaurante"
    WScript.Quit 1
  End If
End If

edge = ""
If fso.FileExists(sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe") Then edge = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe"
If edge = "" And fso.FileExists(sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe") Then edge = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe"
If edge <> "" Then
  ' --kiosk-printing: imprime directo en la impresora predeterminada de Windows, sin ventana
  sh.Run """" & edge & """ --app=" & url & " --start-maximized --kiosk-printing --no-first-run --no-default-browser-check --user-data-dir=""" & dir & "\datos\navegador""", 1, False
Else
  sh.Run url, 1, False
End If
