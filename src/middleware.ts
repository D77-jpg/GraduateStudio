import { auth } from "@/server/auth";

/**
 * 页面层登录保护:未登录访问受保护页面时重定向到登录页。
 * API 层的鉴权(401)与资源归属校验(403/404)在各 route 内完成,此处只兜页面。
 * 登录/注册/公开 API(health、auth 回调)不在 matcher 内。
 */
export default auth((req) => {
  if (!req.auth) {
    const signInUrl = new URL("/login", req.url);
    signInUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
    return Response.redirect(signInUrl);
  }
});

export const config = {
  matcher: ["/dashboard/:path*", "/projects/:path*", "/settings/:path*"],
};
