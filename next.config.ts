import type { NextConfig } from "next";

const config: NextConfig = {
  cacheComponents: false,
  distDir: process.env.COUNTERSHOT_BUILD_DIR || ".next",
  serverExternalPackages: ["node:sqlite"],
  poweredByHeader: false,
  devIndicators: false,
};

export default config;
