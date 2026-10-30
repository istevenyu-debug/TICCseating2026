@echo off
chcp 65001 >nul
cd /d "%~dp0"
call npx tsx scripts\restore.ts
pause
