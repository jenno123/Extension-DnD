@echo off
REM Optional: only needed if you want to test WITHOUT the cloud relay.
REM In that case also set RELAY_URL=ws://localhost:8787 in the listener .env.
cd /d "%~dp0packages\relay"
npm start
