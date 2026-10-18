import { describe, expect, it } from "vitest";
import { summarizeAiNetworkError } from "@/server/ai/network-diagnostics";

const SECRET = "sk-private https://user:password@example.com/private?token=secret";

describe("summarizeAiNetworkError", () => {
  it("summarizes SDK wrappers and nested transport causes without leaking secrets", () => {
    const error = {
      name: "AI_RetryError",
      message: SECRET,
      cause: {
        name: "AI_APICallError",
        statusCode: 503,
        url: SECRET,
        requestBodyValues: { apiKey: SECRET },
        responseBody: SECRET,
        cause: new TypeError(SECRET, {
          cause: { code: "UND_ERR_HEADERS_TIMEOUT", message: SECRET },
        }),
      },
    };
    expect(summarizeAiNetworkError(error)).toBe(
      "AI_RetryError / AI_APICallError / TypeError；HTTP 503；UND_ERR_HEADERS_TIMEOUT（等待响应头超时）",
    );
    expect(summarizeAiNetworkError(error)).not.toMatch(/sk-private|https|password|token|300/);
  });

  it.each([
    ["UND_ERR_HEADERS_TIMEOUT", "等待响应头超时"],
    ["UND_ERR_BODY_TIMEOUT", "读取响应体超时"],
    ["UND_ERR_SOCKET", "连接套接字异常"],
    ["ECONNRESET", "连接被重置"],
    ["ECONNREFUSED", "连接被拒绝"],
    ["ETIMEDOUT", "连接或网络操作超时"],
    ["ENOTFOUND", "域名解析失败"],
    ["EPIPE", "连接管道已关闭"],
  ])("includes only the known code %s and its fixed description", (code, description) => {
    expect(summarizeAiNetworkError({ code })).toBe(`${code}（${description}）`);
  });

  it.each(["AI_APICallError", "AI_RetryError", "TypeError", "AbortError", "TimeoutError"])(
    "allows the exact error name %s",
    (name) => expect(summarizeAiNetworkError({ name, message: SECRET })).toBe(name),
  );

  it.each([100, 200, 429, 500, 599])("allows integer HTTP status %s", (statusCode) => {
    expect(summarizeAiNetworkError({ statusCode })).toBe(`HTTP ${statusCode}`);
    expect(summarizeAiNetworkError({ status: statusCode })).toBe(`HTTP ${statusCode}`);
  });

  it.each([99, 600, 200.5, NaN, Infinity, "503", SECRET, null, {}])(
    "does not coerce invalid status %s",
    (statusCode) => expect(summarizeAiNetworkError({ statusCode, status: statusCode })).toBe(""),
  );

  it("prefers the first valid status in the bounded chain", () => {
    expect(
      summarizeAiNetworkError({ statusCode: 401, status: 502, cause: { statusCode: 503 } }),
    ).toBe("HTTP 401");
    expect(summarizeAiNetworkError({ statusCode: SECRET, status: 429 })).toBe("HTTP 429");
  });

  it.each([undefined, null, SECRET, 42, true, Symbol("secret"), new Error(SECRET)])(
    "returns an empty diagnostic for unsupported input %s",
    (error) => expect(summarizeAiNetworkError(error)).toBe(""),
  );

  it("rejects unknown names/codes, including strings with allowed prefixes", () => {
    expect(summarizeAiNetworkError({ name: `TypeError ${SECRET}`, code: `EPIPE ${SECRET}` })).toBe(
      "",
    );
    expect(summarizeAiNetworkError({ name: SECRET, code: SECRET, apiKey: SECRET })).toBe("");
  });

  it("stops cyclic causes and deduplicates metadata", () => {
    const error: { name: string; code: string; cause?: unknown } = {
      name: "TypeError",
      code: "ECONNRESET",
    };
    error.cause = { name: "TypeError", code: "ECONNRESET", cause: error };
    expect(summarizeAiNetworkError(error)).toBe("TypeError；ECONNRESET（连接被重置）");
  });

  it("inspects up to five causes and never reads beyond the boundary", () => {
    const fifthCause = {
      code: "EPIPE",
      get cause(): never {
        throw new Error("must not read sixth cause");
      },
    };
    let root: object = fifthCause;
    for (let i = 0; i < 5; i++) root = { cause: root };
    expect(summarizeAiNetworkError(root)).toBe("EPIPE（连接管道已关闭）");
    expect(summarizeAiNetworkError({ cause: root })).toBe("");
  });

  it("handles throwing allowlisted getters independently", () => {
    const error = Object.defineProperties(
      {},
      {
        name: {
          get() {
            throw new Error(SECRET);
          },
        },
        statusCode: {
          get() {
            throw new Error(SECRET);
          },
        },
        status: { value: 502 },
        code: {
          get() {
            throw new Error(SECRET);
          },
        },
        cause: { value: { code: "ENOTFOUND" } },
      },
    );
    expect(summarizeAiNetworkError(error)).toBe("HTTP 502；ENOTFOUND（域名解析失败）");
    expect(
      summarizeAiNetworkError(
        Object.defineProperty({}, "cause", {
          get() {
            throw new Error(SECRET);
          },
        }),
      ),
    ).toBe("");
  });

  it("does not read private fields or coerce hostile values", () => {
    const reads: string[] = [];
    const error = new Proxy(
      { name: "AbortError", code: "EPIPE" },
      {
        get(target, key, receiver) {
          reads.push(String(key));
          if (!["name", "statusCode", "status", "code", "cause"].includes(String(key))) {
            throw new Error("private property read");
          }
          return Reflect.get(target, key, receiver);
        },
      },
    );
    expect(summarizeAiNetworkError(error)).toBe("AbortError；EPIPE（连接管道已关闭）");
    expect(reads).toEqual(["name", "statusCode", "status", "code", "cause"]);
    const hostile = {
      toString() {
        throw new Error(SECRET);
      },
    };
    expect(summarizeAiNetworkError({ name: hostile, code: hostile, statusCode: hostile })).toBe("");
    expect(
      summarizeAiNetworkError(
        new Proxy(
          {},
          {
            get() {
              throw new Error(SECRET);
            },
          },
        ),
      ),
    ).toBe("");
  });
});
