@echo off
cd /d "%~dp0"
echo Starting D^&D Voice Overlay (relay + Discord listener)...
echo Make sure the Discord desktop app is running and you are in your voice channel.
echo.
start "DnD Overlay - Relay"    cmd /k "cd /d %~dp0packages\relay && npm start"
timeout /t 2 >nul
start "DnD Overlay - Listener" cmd /k "cd /d %~dp0packages\discord-listener && npm start"
echo Two windows opened. Close them (or this one) to stop.
timeout /t 4 >nul
exit /b 0
