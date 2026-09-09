@echo off
setlocal
cd /d "%~dp0"
title PixelOffice App
set PIXEL_OFFICE_MODE=production

call npm run app
if errorlevel 1 (
  echo.
  echo PixelOffice app launcher exited with an error.
  pause
)

endlocal
