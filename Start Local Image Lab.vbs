Option Explicit
Dim shell, fs, root, command
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
root = fs.GetParentFolderName(WScript.ScriptFullName)
If Not fs.FileExists(root & "\runtime\node.exe") Then
  MsgBox "Local Image Lab is not installed yet." & vbCrLf & vbCrLf & "Double-click Install.cmd in this folder first.", vbExclamation, "Local Image Lab"
  WScript.Quit 1
End If
shell.CurrentDirectory = root
command = Chr(34) & root & "\runtime\node.exe" & Chr(34) & " " & Chr(34) & root & "\app\server.mjs" & Chr(34) & " --open"
shell.Run command, 0, False
