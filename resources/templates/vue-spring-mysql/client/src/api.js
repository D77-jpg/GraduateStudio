// 统一请求：自动携带令牌、解包 {code, message, data}、401 时回到登录页。
const TOKEN_KEY = "token";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export async function request(path, { method = "GET", body } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({ code: response.status, message: response.statusText }));
  if (response.status === 401 && path !== "/api/auth/login") {
    setToken(null);
    if (typeof window !== "undefined" && window.location.pathname !== "/login") window.location.assign("/login");
  }
  if (!response.ok || json.code !== 0) throw new Error(json.message || `请求失败（${response.status}）`);
  return json.data;
}
