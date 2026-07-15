@echo off
setlocal

cd /d "%~dp0"
set "PORT=3000"

echo.
echo Serving FFF TV Ranking on port %PORT%.
echo Keep this window open while testing.
echo.
echo Local computer: http://localhost:%PORT%/
echo Other devices:   http://YOUR-COMPUTER-LAN-IP:%PORT%/
echo.
echo To find the LAN IP, run ipconfig and use the IPv4 Address for your active Wi-Fi or Ethernet adapter.
echo If live Edge Function calls are blocked, add http://YOUR-COMPUTER-LAN-IP:%PORT% to ALLOWED_ORIGINS.
echo.

where py >nul 2>nul
if not errorlevel 1 (
  py -3 -m http.server %PORT% --bind 0.0.0.0
  goto :done
)

where python >nul 2>nul
if not errorlevel 1 (
  python -m http.server %PORT% --bind 0.0.0.0
  goto :done
)

echo Python was not found. Install Python or run another static file server on port %PORT%.
pause

:done
