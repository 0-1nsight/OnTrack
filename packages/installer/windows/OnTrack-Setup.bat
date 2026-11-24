@echo off
setlocal
set "SOURCE_DIR=%~dp0"
set "ONTRACK_TMP=%LOCALAPPDATA%\OnTrack\Installer"
if not exist "%ONTRACK_TMP%" mkdir "%ONTRACK_TMP%"
cd /d "%ONTRACK_TMP%"

set "CS_FILE=%ONTRACK_TMP%\OnTrackSetup.cs"
set "BUNDLE_FILE=%ONTRACK_TMP%\ontrack-bundle.zip"
set "OUT_EXE=%ONTRACK_TMP%\OnTrack-Setup.exe"

if exist "%CS_FILE%" del /f /q "%CS_FILE%" >nul 2>nul
if exist "%BUNDLE_FILE%" del /f /q "%BUNDLE_FILE%" >nul 2>nul
if exist "%OUT_EXE%" del /f /q "%OUT_EXE%" >nul 2>nul

if exist "%SOURCE_DIR%OnTrackSetup.cs" if exist "%SOURCE_DIR%ontrack-bundle.zip" (
  copy /y "%SOURCE_DIR%OnTrackSetup.cs" "%CS_FILE%" >nul
  copy /y "%SOURCE_DIR%ontrack-bundle.zip" "%BUNDLE_FILE%" >nul
)

if exist "%CS_FILE%" if exist "%BUNDLE_FILE%" goto :compile_installer

echo Unpacking embedded OnTrack installer payload...
set "OT_BAT=%~f0"
set "OT_OUT=%ONTRACK_TMP%"
set "PS_EXE=powershell"
if exist "%WINDIR%\System32\WindowsPowerShell\v1.0\powershell.exe" (
  set "PS_EXE=%WINDIR%\System32\WindowsPowerShell\v1.0\powershell.exe"
)
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $t=[IO.File]::ReadAllText($env:OT_BAT); $s1='__ONTRACK_'+'CS_B64_START__'; $e1='__ONTRACK_'+'CS_B64_END__'; $s2='__ONTRACK_'+'ZIP_B64_START__'; $e2='__ONTRACK_'+'ZIP_B64_END__'; $m1=[regex]::Match($t,$s1+'\r?\n([\s\S]*?)\r?\n'+$e1); if(-not $m1.Success){throw 'Embedded OnTrackSetup.cs payload not found.'}; [IO.File]::WriteAllBytes((Join-Path $env:OT_OUT 'OnTrackSetup.cs'),[Convert]::FromBase64String(($m1.Groups[1].Value -replace '\s',''))); $m2=[regex]::Match($t,$s2+'\r?\n([\s\S]*?)\r?\n'+$e2); if(-not $m2.Success){throw 'Embedded ontrack-bundle.zip payload not found.'}; [IO.File]::WriteAllBytes((Join-Path $env:OT_OUT 'ontrack-bundle.zip'),[Convert]::FromBase64String(($m2.Groups[1].Value -replace '\s','')))"
if errorlevel 1 (
  echo.
  echo Failed to unpack embedded OnTrack installer payload.
  echo Please right-click the downloaded ZIP file, choose "Extract All...", and run OnTrack-Setup.bat from the extracted folder.
  pause
  exit /b 1
)

:compile_installer
if not exist "%CS_FILE%" (
  echo Missing installer source file: "%CS_FILE%"
  pause
  exit /b 1
)
if not exist "%BUNDLE_FILE%" (
  echo Missing installer bundle: "%BUNDLE_FILE%"
  pause
  exit /b 1
)

set "CSC_EXE="
if exist "%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" (
  set "CSC_EXE=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
) else if exist "%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe" (
  set "CSC_EXE=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)

if not defined CSC_EXE (
  echo Failed to locate .NET Framework compiler ^(csc.exe^). Ensure Windows .NET Framework 4.x is enabled.
  pause
  exit /b 1
)

echo Launching OnTrack Collector Setup...
"%CSC_EXE%" /nologo /target:winexe /optimize+ ^
  /r:System.dll,System.Drawing.dll,System.Windows.Forms.dll,System.IO.Compression.dll,System.IO.Compression.FileSystem.dll ^
  "/out:%OUT_EXE%" "%CS_FILE%"
if errorlevel 1 (
  echo.
  echo Failed to compile OnTrack-Setup.exe using "%CSC_EXE%".
  pause
  exit /b 1
)

if exist "%OUT_EXE%" (
  start "" "%OUT_EXE%" %*
  exit /b 0
)

echo Failed to create "%OUT_EXE%".
pause
exit /b 1
