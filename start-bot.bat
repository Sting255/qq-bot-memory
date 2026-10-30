@echo off
cd /d "%~dp0"
if not exist "data" mkdir data
:loop
echo [%date% %time%] starting bot >> data\bot-restart.log
node src\main.js >> data\bot-run.log 2>&1
echo [%date% %time%] bot exited with %errorlevel%, restart in 10s >> data\bot-restart.log
ping -n 11 127.0.0.1 > nul
goto loop
