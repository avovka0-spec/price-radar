' Launches a command line hidden (no console window).
' Usage: wscript.exe //nologo scripts\run-hidden.vbs "C:\path\to\node.exe" "scripts\opencode-issues-watcher.mjs"
'   or:  wscript.exe //nologo scripts\run-hidden.vbs "node scripts\opencode-issues-watcher.mjs"
' If multiple arguments are passed, they are joined with spaces as a single command line.
' Prefer a single, pre-quoted command string argument for complex quoting.
Option Explicit

If WScript.Arguments.Count = 0 Then WScript.Quit 1

Dim shell, cmd, i
Set shell = CreateObject("WScript.Shell")
cmd = ""
For i = 0 To WScript.Arguments.Count - 1
  If i > 0 Then cmd = cmd & " "
  cmd = cmd & WScript.Arguments(i)
Next

' 0 = hidden window, False = do not wait for completion
shell.Run cmd, 0, False
