@echo off
setlocal
cd /d "%~dp0"
title PixelOffice Dev
set PIXEL_OFFICE_MODE=development

call npm run dev
if errorlevel 1 (
  echo.
  echo PixelOffice dev launcher exited with an error.
  pause
)

endlocal
