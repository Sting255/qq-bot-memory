' 静默启动 qq-bot-memory：不弹出控制台窗口，崩了自动重启
' 用法：双击本文件，或做成开机启动项 / 计划任务
Option Explicit

Dim fso, sh, here
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here

' 第二个参数 0 = 窗口隐藏，第三个参数 False = 启动后立刻返回
sh.Run "cmd /c """ & here & "\start-bot.bat""", 0, False
