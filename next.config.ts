import type { NextConfig } from 'next';
import { apiRewrites } from './src/deployment/config';
const config: NextConfig = {
  allowedDevOrigins: ['127.0.0.1'],
  serverExternalPackages: ['undici'],
  poweredByHeader: false,
  async rewrites() { return apiRewrites(process.env); },
  async headers() { return [{source: '/:path*', headers: [
    {key:'X-Content-Type-Options',value:'nosniff'},
    {key:'Referrer-Policy',value:'same-origin'},
    {key:'X-Frame-Options',value:'DENY'},
    {key:'Permissions-Policy',value:'camera=(self), microphone=()'},
  ]}]; },
};
export default config;
