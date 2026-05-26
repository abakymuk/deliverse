import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@rp/ui', '@rp/auth-core', '@rp/db'],
  typedRoutes: true,
};

export default config;
