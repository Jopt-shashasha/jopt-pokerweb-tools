@echo off
setlocal
chcp 65001 >nul
py -3.12 -c "pass" >nul 2>nul
if errorlevel 1 (
  py -3 "%~dp0install.py" %*
) else (
  py -3.12 "%~dp0install.py" %*
)
set "INSTALL_EXIT=%ERRORLEVEL%"
if not "%INSTALL_EXIT%"=="0" (
  echo.
  echo Installation did not finish. See the message above.
)
if "%~1"=="" pause
exit /b %INSTALL_EXIT%
