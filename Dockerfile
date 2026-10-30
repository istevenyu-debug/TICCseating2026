# 雲端（Google Cloud Run）用的映像檔。本機測試站不需要這個檔案。
FROM node:20-slim
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production
# Cloud Run 會給 PORT（預設 8080）
CMD ["sh", "-c", "npx next start -p ${PORT:-8080}"]
