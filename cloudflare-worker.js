/**
 * Cloudflare Worker：把 ticket.aolforgood.com 轉到 Google Cloud Run。
 * 部署腳本（scripts/gcp-deploy.sh）跑完會印出已填好網址的版本，貼到 Cloudflare 的 Worker 編輯器即可。
 *
 * 切換：在 Worker 設定加上路由 ticket.aolforgood.com/* → 立即改走雲端。
 * 退回：刪掉那條路由 → 立即改回原本的通道（家裡電腦）。
 */
const CLOUD_RUN = 'https://REPLACE-WITH-CLOUD-RUN-URL';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, CLOUD_RUN);
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', 'https');
    headers.set('x-ticc-client-ip', request.headers.get('cf-connecting-ip') ?? '');
    return fetch(target, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
      redirect: 'manual',
    });
  },
};
