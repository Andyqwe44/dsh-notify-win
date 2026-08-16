' focus-dsh.vbs - hidden launcher for focus-dsh.ps1 (no console flash).
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -File ""C:\Users\Andyq\codes\dsh-plugin\dsh-notify-win\lib\focus-dsh.ps1""", 0, True
