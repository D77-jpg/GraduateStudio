export class ApiError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

/** 统一的客户端 JSON 请求:非 2xx 时抛出带服务端错误信息的 ApiError。 */
export async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });

  if (!res.ok) {
    let message = `请求失败(${res.status})`;
    let code = "unknown";
    try {
      const data: unknown = await res.json();
      const err = (data as { error?: { code?: string; message?: string } }).error;
      if (err?.message) message = err.message;
      if (err?.code) code = err.code;
    } catch {
      // 保留默认错误信息
    }
    throw new ApiError(message, code, res.status);
  }

  return (await res.json()) as T;
}
