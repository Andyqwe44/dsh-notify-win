' focus-dsh.vbs - hidden launcher for focus-dsh.ps1 (no console flash).
Set sh = CreateObject("WScript.Shell")
If WScript.Arguments.Count > 0 Then
  uri = WScript.Arguments(0)
Else
  uri = ""
End If
sh.Run "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -File ""C:\Users\Andyq\codes\dsh-plugin\dsh-notify-win\lib\focus-dsh.ps1"" """ & uri & """", 0, True
