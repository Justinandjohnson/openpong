import path from "node:path";
import type { NextConfig } from "next";

const appDir = path.dirname(new URL(import.meta.url).pathname);
const workspaceRoot = path.resolve(appDir, "../..");

const nextConfig: NextConfig = {
  reactStrictMode: false,
  turbopack: {
    root: workspaceRoot,
  },
  outputFileTracingRoot: workspaceRoot,
};

export default nextConfig;