' ============================================================
'  Cost Control System - silent start in SHARED (LAN) mode
'  - Double-click : starts server, opens browser, shows addresses
'  - Run with "quiet" arg : starts server only, no window/popup
'  - Idempotent: exits instantly if the server is already up
'  To stop it: run  stop-server.cmd
' ============================================================
Dim sh, fso, folder, quiet
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = folder
quiet = (WScript.Arguments.Count > 0)

' already running -> do nothing (safe for repeated/keep-alive runs)
If ServerUp() Then WScript.Quit 0

' start node hidden, bound to all network interfaces
sh.Run "cmd /c set HOST=0.0.0.0&& node src/server.js", 0, False

' wait until the server answers
Dim i, ok, ip
ok = False
For i = 1 To 40
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

Function GetLanIp()
  Dim wmi, cols, c, ip
  ip = ""
  On Error Resume Next
  Set wmi = GetObject("winmgmts:\\.\root\cimv2")
  Set cols = wmi.ExecQuery("Select IPAddress From Win32_NetworkAdapterConfiguration Where IPEnabled=True")
  For Each c In cols
    If IsArray(c.IPAddress) Then
      Dim a
      For Each a In c.IPAddress
        If InStr(a, ".") > 0 And Left(a, 4) <> "127." And Left(a, 8) <> "169.254." Then
          ip = a
        End If
      Next
    End If
  Next
  On Error GoTo 0
  GetLanIp = ip
End Function
