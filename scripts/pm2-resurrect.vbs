Option Explicit

' Run PM2 recovery without showing a Command Prompt or PowerShell window.
Dim shell
Set shell = CreateObject("WScript.Shell")

shell.Environment("Process")("PM2_HOME") = "C:\Users\neil_\.pm2"
shell.Environment("Process")("PATH") = "C:\Program Files\nodejs;C:\Users\neil_\AppData\Roaming\npm;" & shell.Environment("Process")("PATH")
' Call Node directly. The recovery helper leaves an already-online bot alone
' and restores PM2's saved process list only when it is missing.
shell.Run """C:\Program Files\nodejs\node.exe"" ""D:\Wow Addons\PizzaWarriors-Armory-Bot\scripts\pm2-recover.js""", 0, False
