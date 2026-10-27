#!/bin/bash
# Mac：在 Finder 點兩下執行；若被擋，請在「終端機」輸入 bash 後把這個檔案拖進去，再按 Enter
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "請先安裝 Node.js 20 LTS：https://nodejs.org"; read -r; exit 1; }
npm install --no-audit --no-fund
npm run test-site
