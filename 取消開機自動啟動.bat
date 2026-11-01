@echo off
chcp 65001 >nul
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ticc-autostart.cmd" 2>nul
echo 已取消開機自動啟動。
pause
