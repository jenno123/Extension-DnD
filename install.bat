@echo off
cd /d "%~dp0"
echo ============================================
echo  D^&D Voice Overlay - one-time setup
echo ============================================
echo.
echo Installing + building the relay...
cd /d "%~dp0packages\relay"
call npm install || goto :err
call npm run build || goto :err
echo.
echo Installing + building the Discord listener...
cd /d "%~dp0packages\discord-listener"
call npm install || goto :err
call npm run build || goto :err
echo.
echo ============================================
echo  Setup complete. Now double-click start.bat
echo ============================================
pause
exit /b 0
:err
echo.
echo Something went wrong during setup. Make sure Node.js is installed.
pause
exit /b 1
