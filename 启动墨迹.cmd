@echo off
rem ---------------------------------------------------------------------------
rem Double-click launcher for MoJi (Windows) - browser mode.
rem
rem It starts the local server in the background and opens the browser.
rem pythonw.exe is used on purpose: it has no console window, so the server
rem keeps running after this window closes.
rem
rem Starting twice is harmless: the server notices an instance already
rem listening on the port and just opens the browser (see server/__main__.py).
rem
rem This file is intentionally ASCII-only: .cmd files are read with the system
rem code page, and non-ASCII text here is a classic source of garbled output.
rem ---------------------------------------------------------------------------

cd /d "%~dp0"

if not exist "dist\index.html" (
    echo The frontend has not been built yet.
    echo.
    echo Run these two commands once in this folder:
    echo     npm install
    echo     npm run build
    echo.
    echo ^(For the desktop app instead, run: scripts\build-desktop.cmd^)
    pause
    exit /b 1
)

where pythonw >nul 2>&1
if %errorlevel%==0 (
    start "" pythonw -m server --open
    exit /b 0
)

where python >nul 2>&1
if %errorlevel%==0 (
    start "" python -m server --open
    exit /b 0
)

echo.
echo Python not found.
echo.
echo MoJi's browser mode is built on the Python standard library only.
echo Install Python 3.10 or newer, then run this file again:
echo   https://www.python.org/downloads/
echo.
pause
exit /b 1
