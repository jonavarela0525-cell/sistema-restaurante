' Inicia el servidor del Sistema del Restaurante en segundo plano (al encender la computadora)
Dim sh, fso, dir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
' En modo conectado (config.json con "servidorRemoto") esta computadora no corre su propio servidor
If fso.FileExists(dir & "\config.json") Then
  Dim t : t = fso.OpenTextFile(dir & "\config.json", 1).ReadAll
  Dim r : Set r = New RegExp : r.Pattern = """servidorRemoto""\s*:\s*""[^""]+"""
  If r.Test(t) Then WScript.Quit 0
End If
If Not fso.FolderExists(dir & "\datos") Then fso.CreateFolder(dir & "\datos")
sh.Run "cmd /c node """ & dir & "\lanzador.js"" >> """ & dir & "\datos\consola.log"" 2>&1", 0, False
