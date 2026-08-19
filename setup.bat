@echo off
cd /d "%~dp0"
if not exist .env (
  echo Missing .env file. Copy .env.example to .env and add database details.
  pause
  exit /b 1
)
echo Checking database connection and Connect role mappings...
node --env-file=.env scripts\check-database.js
pause
