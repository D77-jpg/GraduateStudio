import type { NextConfig } from "next";

/**
 * 生产安全头:
 * - X-Frame-Options SAMEORIGIN 防点击劫持(项目 Runtime 预览 iframe 嵌的是用户项目自己的 dev server,不受此头约束);
 * - nosniff / Referrer-Policy 基础加固;
 * - Permissions-Policy 收敛浏览器能力。
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
