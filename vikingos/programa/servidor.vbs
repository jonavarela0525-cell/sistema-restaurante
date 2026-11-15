' Inicia el servidor del Sistema Vikingos en segundo plano (al encender la computadora)
Dim sh, fso, dir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
If Not fso.FolderExists(dir & "\datos") Then fso.CreateFolder(dir & "\datos")
sh.Run "cmd /c node """ & dir & "\lanzador.js"" >> """ & dir & "\datos\consola.log"" 2>&1", 0, False
