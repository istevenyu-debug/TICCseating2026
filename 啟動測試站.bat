@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo 請先安裝 Node.js 20 LTS 以上：https://nodejs.org & pause & exit /b 1)
call npm install --no-audit --no-fund
call npm run test-site
pause
