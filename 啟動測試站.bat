@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo 請先安裝 Node.js 20 LTS：https://nodejs.org & pause & exit /b 1)
if not exist node_modules call npm install
call npm run test-site
pause
