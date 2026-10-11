@echo off
setlocal
title Subtitle Studio
cd /d "%~dp0"

if not exist "venv\Scripts\python.exe" (
    echo.
    echo    First run - Subtitle Studio needs to set itself up.
    echo.
    call setup.bat
    if errorlevel 1 (
        pause
        exit /b 1
    )
)

where ffmpeg >nul 2>nul
if errorlevel 1 if not exist "%~dp0bin\ffmpeg.exe" (
    echo.
    echo    ffmpeg was not found. Install it with:   winget install Gyan.FFmpeg
    echo    then close this window and start again.
    echo.
)

venv\Scripts\python server.py %*

echo.
echo    Subtitle Studio stopped.
pause
