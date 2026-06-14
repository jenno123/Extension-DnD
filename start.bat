@echo off
cd /d "%~dp0"
echo Starting D^&D Voice Overlay - Discord listener...
echo (The relay runs in the cloud on Render; only the listener runs here.)
echo Make sure the Discord desktop app is running and you are in your voice channel.
echo.
cd /d "%~dp0packages\discord-listener"
npm start
