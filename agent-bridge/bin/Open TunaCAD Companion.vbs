Option Explicit
Dim shell, files, cli, command, result
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
cli = files.BuildPath(files.GetParentFolderName(WScript.ScriptFullName), "tunacad-agent-bridge.mjs")
command = "node.exe " & Chr(34) & cli & Chr(34) & " companion-ui"
On Error Resume Next
result = shell.Run(command, 0, True)
If Err.Number <> 0 Or result <> 0 Then
  MsgBox "Could not open TunaCAD Companion. Check that Node.js 20 or newer and Windows PowerShell are available, then try again.", 16, "TunaCAD Companion"
End If
