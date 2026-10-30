' qq-bot-memory silent launcher
' Starts start-bot.bat with no console window; the bat restarts the bot 10s after it exits.
' Usage: double-click this file, or place a shortcut to it in shell:startup
' NOTE: keep this file ASCII-only. VBScript reads scripts as ANSI, so UTF-8
' comments (e.g. Chinese) can swallow the following line and break the script.
Option Explicit

Dim fso, sh, here
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here

' 0 = hidden window, False = do not wait for the process
sh.Run "cmd /c """ & here & "\start-bot.bat""", 0, False
