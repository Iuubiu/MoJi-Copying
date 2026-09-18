@echo off
rem ---------------------------------------------------------------------------
rem Build the desktop installer (Tauri + NSIS) on Windows.
rem
rem Why this file exists: rustup was installed without touching the system PATH,
rem so `tauri build` cannot find `cargo` even though Rust works fine. Prepending
rem the toolchain directory here keeps that detail out of the way.
rem
rem Usage:  scripts\build-desktop.cmd          (installer)
rem         scripts\build-desktop.cmd --debug  (debug build, faster)
rem
rem Output: src-tauri\target\release\bundle\nsis\*.exe
rem ---------------------------------------------------------------------------

setlocal
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
cd /d "%~dp0.."

if not exist "node_modules" (
    echo Installing frontend dependencies...
    call npm install || exit /b 1
)

call npm run app:build -- %*
set "CODE=%ERRORLEVEL%"

if "%CODE%"=="0" (
    echo.
    echo Build finished. Installer is under src-tauri\target\release\bundle\nsis\
) else (
    echo.
    echo Build failed with exit code %CODE%.
)

endlocal & exit /b %CODE%
