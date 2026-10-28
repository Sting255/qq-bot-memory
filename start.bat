@echo off
setlocal
cd /d "%~dp0"

title Zili QQ Bot

echo ========================================
echo   Zili QQ Memory Bot
echo ========================================
echo.

if not exist "config.yaml" (
    echo [INFO] config.yaml not found, creating from template...
    copy config.example.yaml config.yaml >nul
    echo.
    echo [INFO] Please edit config.yaml and fill in LLM settings.
    echo.
    pause
    exit /b 1
)

echo Starting all services (NapCat + vector service + bot)...
echo.

node src\main.js

set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo ========================================
echo   Bot exited with code %EXIT_CODE%
echo ========================================
if not "%EXIT_CODE%"=="0" (
    echo.
    echo Check data\bot.log for details.
)
echo.
pause
endlocal
