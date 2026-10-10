@echo off
setlocal
cd /d "%~dp0"
echo Wire Wednesday local Cloudflare development
echo Local: http://127.0.0.1:3000/
echo Synthetic demo: http://127.0.0.1:3000/?demo=1
echo Keep this window open. Google configuration is read from ignored .env.vars.
if not exist .env.vars (
  echo Missing .env.vars. Configure GOOGLE_CLIENT_ID locally first.
  exit /b 1
)
call npx.cmd wrangler d1 migrations apply DB --local --persist-to .wrangler/hosting-local
if errorlevel 1 exit /b 1
call npx.cmd wrangler dev --local --local-upstream 127.0.0.1:3000 --env-file .env.vars --port 3000 --var APP_ORIGIN:http://127.0.0.1:3000 --var LOCAL_DEMO:true --persist-to .wrangler/hosting-local --log-level warn
