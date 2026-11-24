@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "ONTRACK_TMP=%LOCALAPPDATA%\OnTrack\Installer"
if not exist "%ONTRACK_TMP%" mkdir "%ONTRACK_TMP%"

set "CSC_EXE="
if exist "%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" (
  set "CSC_EXE=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
) else if exist "%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe" (
  set "CSC_EXE=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)

if defined CSC_EXE (
  copy /y "%~dp0ontrack-bundle.zip" "%ONTRACK_TMP%\ontrack-bundle.zip" >nul
  "%CSC_EXE%" /nologo /target:winexe /optimize+ ^
    /r:System.dll,System.Drawing.dll,System.Windows.Forms.dll,System.IO.Compression.dll,System.IO.Compression.FileSystem.dll ^
    "/out:%ONTRACK_TMP%\OnTrack-Setup.exe" "%~dp0OnTrackSetup.cs"
  if exist "%ONTRACK_TMP%\OnTrack-Setup.exe" (
    start "" "%ONTRACK_TMP%\OnTrack-Setup.exe" %*
    exit /b 0
  )
)

echo Failed to locate .NET Framework compiler (csc.exe). Ensure Windows .NET 4.x is enabled.
pause
exit /b 1
