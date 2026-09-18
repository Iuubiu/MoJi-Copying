@echo off
rem ---------------------------------------------------------------------------
rem Build the desktop installer (Tauri + NSIS) on Windows.
rem
rem Rust comes from scoop (the "rustup" package). scoop writes RUSTUP_HOME /
rem CARGO_HOME / PATH into the *user* environment, but a terminal that was
rem already open before the install keeps the old snapshot - so fill in the
rem blanks here rather than failing with "cargo: program not found".
rem
rem NOTE: keep this file ASCII-only. .cmd files are read with the system code
rem page, and non-ASCII text here turns into garbage commands.
rem
rem Usage:  scripts\build-desktop.cmd          (installer)
rem         scripts\build-desktop.cmd --debug  (debug build, faster)
rem
rem Output: src-tauri\target\release\bundle\nsis\*.exe
rem ---------------------------------------------------------------------------

setlocal

if not defined RUSTUP_HOME set "RUSTUP_HOME=%USERPROFILE%\scoop\persist\rustup\.rustup"
if not defined CARGO_HOME  set "CARGO_HOME=%USERPROFILE%\scoop\persist\rustup\.cargo"
where cargo >nul 2>&1 || set "PATH=%CARGO_HOME%\bin;%PATH%"

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
