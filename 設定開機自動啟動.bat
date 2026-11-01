@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "S=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ticc-autostart.cmd"
> "%S%" echo @echo off
>> "%S%" echo chcp 65001 ^>nul
>> "%S%" echo title TICC seating
>> "%S%" echo cd /d "%~dp0"
>> "%S%" echo timeout /t 30 /nobreak ^>nul
>> "%S%" echo call npm run test-site
>> "%S%" echo pause
echo.
echo 已設定：電腦開機、登入 Windows 後，約 30 秒會自動啟動劃位網站。
echo 網站資料夾：%~dp0
echo 取消請執行「取消開機自動啟動.bat」。
echo.
echo 提醒：若 Windows 有設定登入密碼，開機後要有人登入才會啟動；
echo 可在「設定 → 帳戶 → 登入選項」改為自動登入，或關閉密碼。
pause
