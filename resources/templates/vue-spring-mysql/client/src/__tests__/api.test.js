import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getToken, request, setToken } from "../api.js";

describe("api", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("stores and clears the token", () => {
    setToken("abc");
    expect(getToken()).toBe("abc");
    setToken(null);
    expect(getToken()).toBeNull();
  });

  it("sends the bearer token and unwraps data", async () => {
    setToken("t1");
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ code: 0, message: "ok", data: { x: 1 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(request("/api/x")).resolves.toEqual({ x: 1 });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer t1");
  });

  it("throws the server message on business errors", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ code: 400, message: "标题：不能为空", data: null }), { status: 400 }),
    );
    await expect(request("/api/notices", { method: "POST", body: {} })).rejects.toThrow("标题：不能为空");
  });
});
