@echo off
title VA Panel Fixer
color 0A
echo.
echo  =====================================================
echo    VA Panel Fixer — Starting All Services
echo  =====================================================
echo.

:: Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Python not found. Install from https://python.org
    pause
    exit /b 1
)

:: Install websockets if needed
echo  [1/3] Checking dependencies...
pip install websockets -q

:: Start HTTP server for browser app in a new window
echo  [2/3] Starting browser app server on http://localhost:7890 ...
start "VA Panel — Browser App" cmd /k "python -m http.server 7890 --directory "%~dp0.""

:: Small delay
timeout /t 1 /nobreak >nul

:: Open browser
echo  [3/3] Opening browser...
start "" "http://localhost:7890"

:: Start gamma server in THIS window (shows logs)
echo.
echo  Starting Windows gamma control server...
echo  (Keep this window open while using the app)
echo.
python "%~dp0gamma_server.py"

:: On exit, cleanup
echo.
echo  Gamma server stopped. Display reset to normal.
pause
