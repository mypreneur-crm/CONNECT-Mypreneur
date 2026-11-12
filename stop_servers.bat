@echo off
title Stop Mypreneur Local Servers
cls
echo ======================================================================
echo                  STOPPING ALL 4 LOCAL SERVERS
echo ======================================================================
echo.

set "PORTS=3000 8000 5000 5001"

for %%P in (%PORTS%) do (
    echo [*] Checking and terminating server on Port %%P...
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r /c:":%%P .*LISTENING"') do (
        if not "%%a"=="" if not "%%a"=="0" (
            taskkill /F /PID %%a >nul 2>&1
            echo     [-] Stopped PID %%a on Port %%P
        )
    )
)

echo.
echo ======================================================================
echo All 4 project servers (Ports 3000, 8000, 5000, 5001) have been stopped.
echo ======================================================================
echo.
pause
