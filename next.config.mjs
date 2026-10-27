/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // PGlite（本機開發用的 WASM PostgreSQL）不可被打包
    serverComponentsExternalPackages: ['@electric-sql/pglite', 'pg', 'nodemailer', 'web-push'],
  },
};
export default nextConfig;
