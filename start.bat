@echo off
cd /d "%~dp0"
if not exist .env (
  echo Missing .env file. Copy .env.example to .env and add database details.
  pause
  exit /b 1
)
echo Starting Mypreneur Connect with database-managed login...
node --env-file=.env server.js
pause
