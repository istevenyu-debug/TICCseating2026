#!/usr/bin/env bash
# 一鍵搬上 Google Cloud（在 Google Cloud 網頁的 Cloud Shell 執行）
#
#   bash scripts/gcp-deploy.sh
#
# 會建立／更新：Cloud SQL（PostgreSQL，台灣機房，每日自動備份）、Cloud Run（網站）、
# Cloud Scheduler（每 5 分鐘補寄通知、每日寄備份信）。可以重複執行：第二次起只會更新網站程式。
# 密碼與金鑰存在 Cloud Shell 的 ~/.ticc-env（只在你的 Cloud Shell 裡），請勿刪除。
set -euo pipefail

REGION=asia-east1          # 台灣
SERVICE=ticc
INSTANCE=ticc-db
DB=ticc
DBUSER=ticc
SITE_URL=https://ticket.aolforgood.com
ENV_FILE="$HOME/.ticc-env"

say() { printf '\n\033[1;34m▶ %s\033[0m\n' "$1"; }

PROJECT=$(gcloud config get-value project 2>/dev/null || true)
if [ -z "$PROJECT" ]; then
  PROJECT=$(gcloud projects list --format='value(projectId)' --limit=1)
  [ -n "$PROJECT" ] || { echo '✖ 找不到 Google Cloud 專案。請先在 console.cloud.google.com 建立一個專案。'; exit 1; }
  gcloud config set project "$PROJECT" >/dev/null
fi
echo "專案：$PROJECT　地區：$REGION（台灣）"

# 密碼與金鑰：第一次產生，之後沿用
if [ ! -f "$ENV_FILE" ]; then
  {
    echo "DBPASS=$(openssl rand -hex 16)"
    echo "SESSION_SECRET=$(openssl rand -hex 32)"
    echo "CRON_KEY=$(openssl rand -hex 16)"
    echo "ADMIN_PASSWORD=$(openssl rand -hex 8)"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

say '開啟需要的服務（第一次約 1–2 分鐘）'
gcloud services enable run.googleapis.com sqladmin.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com cloudscheduler.googleapis.com iam.googleapis.com --quiet

if ! gcloud sql instances describe "$INSTANCE" >/dev/null 2>&1; then
  say '建立資料庫（Cloud SQL，約 5–10 分鐘，請稍候）'
  gcloud sql instances create "$INSTANCE" --database-version=POSTGRES_16 --edition=ENTERPRISE \
    --tier=db-f1-micro --region="$REGION" --storage-type=SSD --storage-size=10 \
    --backup-start-time=19:00 --enable-point-in-time-recovery --availability-type=zonal --quiet
fi
gcloud sql databases describe "$DB" --instance="$INSTANCE" >/dev/null 2>&1 || gcloud sql databases create "$DB" --instance="$INSTANCE" --quiet
if gcloud sql users list --instance="$INSTANCE" --format='value(name)' | grep -qx "$DBUSER"; then
  gcloud sql users set-password "$DBUSER" --instance="$INSTANCE" --password="$DBPASS" --quiet >/dev/null
else
  gcloud sql users create "$DBUSER" --instance="$INSTANCE" --password="$DBPASS" --quiet
fi
CONN=$(gcloud sql instances describe "$INSTANCE" --format='value(connectionName)')

say '設定權限'
NUM=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
SA="$NUM-compute@developer.gserviceaccount.com"
for ROLE in roles/cloudsql.client roles/cloudbuild.builds.builder roles/artifactregistry.writer roles/logging.logWriter roles/storage.objectViewer; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" --role="$ROLE" --condition=None --quiet >/dev/null
done

say '上傳程式並建置網站（約 5–8 分鐘）'
gcloud run deploy "$SERVICE" --source . --region="$REGION" --allow-unauthenticated \
  --add-cloudsql-instances="$CONN" --memory=1Gi --cpu=1 --min-instances=0 --max-instances=3 \
  --concurrency=80 --timeout=60 \
  --set-env-vars="DATABASE_URL=postgresql://$DBUSER:$DBPASS@/$DB?host=/cloudsql/$CONN,SESSION_SECRET=$SESSION_SECRET,CRON_KEY=$CRON_KEY,ADMIN_USERNAME=admin,ADMIN_PASSWORD=$ADMIN_PASSWORD,PUBLIC_BASE_URL=$SITE_URL" \
  --quiet
URL=$(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')

say '設定排程（每 5 分鐘補寄通知、每天寄備份信）'
if gcloud scheduler jobs describe ticc-cron --location="$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http ticc-cron --location="$REGION" --schedule='*/5 * * * *' --time-zone='Asia/Taipei' \
    --uri="$URL/api/cron?key=$CRON_KEY" --http-method=GET --quiet >/dev/null
else
  gcloud scheduler jobs create http ticc-cron --location="$REGION" --schedule='*/5 * * * *' --time-zone='Asia/Taipei' \
    --uri="$URL/api/cron?key=$CRON_KEY" --http-method=GET --quiet >/dev/null
fi

sed "s#https://REPLACE-WITH-CLOUD-RUN-URL#$URL#" cloudflare-worker.js > "$HOME/cloudflare-worker.js"

cat <<EOF

============================================================
 ✔ 雲端已建好
 雲端網址（測試用）：$URL/admin
 這是全新的系統，打開後台會請你上傳備份檔把資料搬過來。
 新系統的臨時後台帳號：admin　密碼：$ADMIN_PASSWORD
 （上傳備份後，帳號密碼會變成家裡系統的那一組）

 切換網址用的 Cloudflare Worker 程式（已填好雲端網址）：
   cat ~/cloudflare-worker.js
============================================================
EOF
