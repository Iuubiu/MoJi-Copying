@echo off
rem ---------------------------------------------------------------------------
rem Build the portable edition (Windows): a self-contained MoJi.exe plus an
rem empty data\ folder, zipped up. Unzip anywhere - USB stick included - and run.
rem Nothing gets installed, nothing is written outside that folder.
rem
rem Rust comes from scoop (the "rustup" package). scoop writes RUSTUP_HOME /
rem CARGO_HOME / PATH into the *user* environment, but a terminal that was
rem already open before the install keeps the old snapshot - so fill in the
rem blanks here rather than failing with "cargo: program not found".
rem
rem NOTE: keep this file ASCII-only. .cmd files are read with the system code
rem page, and non-ASCII text here turns into garbage commands. The Chinese
rem readme and the data-folder note live in docs\ and are copied in as-is.
rem
rem Usage:  scripts\build-portable.cmd
rem         scripts\build-portable.cmd --debug   (debug build, faster)
rem
rem Output: dist-portable\MoJi-portable.zip
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

rem --no-bundle: we only want the executable. Tauri 2's --bundles only knows
rem msi/nsis (installers) - the standalone exe is just target\release\MoJi.exe.
echo Building MoJi.exe ...
call npm run app:build -- --no-bundle %*
if errorlevel 1 (
    echo Build failed.
    endlocal & exit /b 1
)

set "STAGE=dist-portable\MoJi"
set "EXE=src-tauri\target\release\MoJi.exe"

if not exist "%EXE%" (
    echo Cannot find %EXE% - the build did not produce it.
    endlocal & exit /b 1
)

echo Packing portable edition ...
if exist "dist-portable" rmdir /s /q "dist-portable"
mkdir "%STAGE%\data"

copy /y "%EXE%" "%STAGE%\MoJi.exe" >nul
copy /y "docs\portable-readme.txt" "%STAGE%\readme.txt" >nul
copy /y "docs\portable-data-note.txt" "%STAGE%\data\README.txt" >nul

rem Zip the *contents* of the folder: unzipping gives MoJi.exe next to data\.
powershell -NoProfile -Command "Compress-Archive -Path 'dist-portable\MoJi\*' -DestinationPath 'dist-portable\MoJi-portable.zip' -Force"
if errorlevel 1 (
    echo Packing failed.
    endlocal & exit /b 1
)

for %%F in ("dist-portable\MoJi-portable.zip") do set "SIZE=%%~zF"
echo.
echo Done. Portable package: dist-portable\MoJi-portable.zip  (%SIZE% bytes)
echo Unzip it anywhere and run MoJi.exe.

endlocal & exit /b 0
