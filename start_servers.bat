@echo off
title Mypreneur Local Servers Manager
cls
echo ======================================================================
echo                  STARTING ALL 4 LOCAL SERVERS
echo ======================================================================
echo.

set "NODE_PATH=C:\Users\Admin\Documents\PROJECT BACKUP\CRM-Mypreneur PROD\.node"
set "PATH=%NODE_PATH%;%PATH%"

set "CONNECT_DIR=C:\Users\Admin\Documents\PROJECT BACKUP\CONNECT-Mypreneur PROD"
set "CRM_DIR=C:\Users\Admin\Documents\PROJECT BACKUP\CRM-Mypreneur PROD"
set "ESS_DIR=C:\Users\Admin\Documents\PROJECT BACKUP\ESS-Mypreneur PROD\backend"
set "FPBUDDY_DIR=C:\Users\Admin\Documents\PROJECT BACKUP\FPBuddy-Mypreneur PROD\backend"

echo [*] Starting CONNECT-Mypreneur (Port 3000)...
start "CONNECT-Mypreneur" /MIN /D "%CONNECT_DIR%" "%NODE_PATH%\node.exe" server.js

echo [*] Starting CRM-Mypreneur (Port 8000)...
start "CRM-Mypreneur" /MIN /D "%CRM_DIR%" "%NODE_PATH%\node.exe" server.js

echo [*] Starting ESS-Mypreneur (Port 5000)...
start "ESS-Mypreneur" /MIN /D "%ESS_DIR%" "%NODE_PATH%\node.exe" dist/index.js

echo [*] Starting FPBuddy-Mypreneur (Port 5001)...
start "FPBuddy-Mypreneur" /MIN /D "%FPBUDDY_DIR%" "%NODE_PATH%\node.exe" server.js

echo.
echo Initializing servers, please wait 3 seconds...
ping 127.0.0.1 -n 4 >nul 2>&1
cls

echo ====================================================================================================
echo                                 MYPRENEUR LOCAL SERVERS STATUS
echo ====================================================================================================
echo.
echo +---------------------+------+-------------------------+----------------------+--------------------+
echo ^| Project Name        ^| Port ^| Local Server URL        ^| Local Database       ^| Status             ^|
echo +---------------------+------+-------------------------+----------------------+--------------------+
echo ^| CONNECT-Mypreneur   ^| 3000 ^| http://localhost:3000   ^| u847929344_myprcr   ^| Online (Active)    ^|
echo ^| CRM-Mypreneur       ^| 8000 ^| http://localhost:8000   ^| u847929344_myprcr   ^| Online (Active)    ^|
echo ^| ESS-Mypreneur       ^| 5000 ^| http://localhost:5000   ^| u847929344_myprcr   ^| Online (Active)    ^|
echo ^| FPBuddy-Mypreneur   ^| 5001 ^| http://localhost:5001   ^| u847929344_FP_buddy ^| Online (Active)    ^|
echo +---------------------+------+-------------------------+----------------------+--------------------+
echo.
echo ====================================================================================================
echo Database Host: 127.0.0.1:3306 (MySQL Server 8.4)
echo All 4 servers are running in the background.
echo To stop all servers, run: stop_servers.bat
echo ====================================================================================================
echo.
pause
