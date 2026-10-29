' ============================================================
'  Cost Control System - silent start (no black window)
'  Double-click: starts the server hidden and opens the browser.
'  To stop it: run  stop-server.cmd
' ============================================================
Dim sh, fso, folder
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = folder

' start node with a HIDDEN window (style 0)
sh.Run "cmd /c node src/server.js", 0, False

' wait until the server answers, then open the browser
Dim i, ok
ok = False
For i = 1 To 20
  WScript.Sleep 500
  If ServerUp() Then ok = True : Exit For
Next

If ok Then
  sh.Run "http://127.0.0.1:4310", 1, False
End If

Function ServerUp()
  Dim http
  On Error Resume Next
  Set http = CreateObject("MSXML2.XMLHTTP")
  http.Open "GET", "http://127.0.0.1:4310/api/health", False
  http.Send
  ServerUp = (Err.Number = 0 And http.Status = 200)
  On Error GoTo 0
End Function
