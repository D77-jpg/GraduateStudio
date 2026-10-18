const ERROR_NAMES = new Set([
  "AI_APICallError",
  "AI_RetryError",
  "TypeError",
  "AbortError",
  "TimeoutError",
]);

const CODE_DESCRIPTIONS = new Map([
  ["UND_ERR_HEADERS_TIMEOUT", "等待响应头超时"],
  ["UND_ERR_BODY_TIMEOUT", "读取响应体超时"],
  ["UND_ERR_SOCKET", "连接套接字异常"],
  ["ECONNRESET", "连接被重置"],
  ["ECONNREFUSED", "连接被拒绝"],
  ["ETIMEDOUT", "连接或网络操作超时"],
  ["ENOTFOUND", "域名解析失败"],
  ["EPIPE", "连接管道已关闭"],
]);

function readProperty(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    // SDK wrappers, proxies and error objects may expose throwing getters.
    return undefined;
  }
}

function isHttpStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
}

/**
 * Return bounded, allowlisted metadata only; unknown errors have no diagnostic.
 * Inspect the root and at most five causes, without coercing or serializing any
 * upstream values. In particular, never read messages, URLs, bodies or headers.
 * Transport timeout codes describe the phase, not its duration or which layer
 * configured it (a local fetch timeout cannot be inferred from a code alone).
 */
export function summarizeAiNetworkError(error: unknown): string {
  const visited = new Set<object>();
  const names = new Set<string>();
  const codes = new Set<string>();
  let status: number | undefined;
  let current = error;

  for (let depth = 0; depth <= 5; depth++) {
    if (
      current === null ||
      (typeof current !== "object" && typeof current !== "function") ||
      visited.has(current)
    ) {
      break;
    }
    visited.add(current);

    const name = readProperty(current, "name");
    if (typeof name === "string" && ERROR_NAMES.has(name)) names.add(name);

    if (status === undefined) {
      const statusCode = readProperty(current, "statusCode");
      if (isHttpStatus(statusCode)) {
        status = statusCode;
      } else {
        const candidate = readProperty(current, "status");
        if (isHttpStatus(candidate)) status = candidate;
      }
    }

    const code = readProperty(current, "code");
    if (typeof code === "string" && CODE_DESCRIPTIONS.has(code)) codes.add(code);

    if (depth < 5) current = readProperty(current, "cause");
  }

  const parts: string[] = [];
  if (names.size) parts.push([...names].join(" / "));
  if (status !== undefined) parts.push(`HTTP ${status}`);
  for (const code of codes) {
    parts.push(`${code}（${CODE_DESCRIPTIONS.get(code)}）`);
  }
  return parts.join("；");
}
