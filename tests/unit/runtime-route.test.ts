import { beforeEach, describe, it, expect, vi } from "vitest";
const m = vi.hoisted(() => ({ auth: vi.fn(), owner: vi.fn(), login: vi.fn() }));
vi.mock("@/server/auth", () => ({ auth: m.auth }));
vi.mock("@/server/agents/context", () => ({ assertProjectOwner: m.owner }));
vi.mock("@/server/runtime/python-stack", () => ({ readPythonPreviewLogin: m.login }));
vi.mock("@/server/runtime/process-manager", () => ({
  getRuntimeStatus: vi.fn(),
  startRuntime: vi.fn(),
  stopRuntime: vi.fn(),
  restartRuntime: vi.fn(),
  buildRuntime: vi.fn(),
  getLogsSince: vi.fn(),
  ErNotConfiguredError: class extends Error {},
}));
import { POST } from "@/app/api/projects/[id]/runtime/route";
const call = () =>
  POST(
    new Request("http://localhost/api/projects/project/runtime?action=preview-login", {
      method: "POST",
    }),
    { params: Promise.resolve({ id: "project" }) },
  );
beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ user: { id: "owner" } });
  m.owner.mockResolvedValue(undefined);
  m.login.mockResolvedValue({ username: "admin", password: "unit-only-value" });
});
describe("preview credentials endpoint", () => {
  it("requires authentication before reading any credentials", async () => {
    m.auth.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
    expect(m.login).not.toHaveBeenCalled();
  });
  it("checks project ownership before reading credentials", async () => {
    m.owner.mockRejectedValue(new Error("not owner"));
    const res = await call();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(m.login).not.toHaveBeenCalled();
  });
  it("returns credentials only on explicit authenticated POST and forbids caching", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(m.owner).toHaveBeenCalledWith("project", "owner");
    expect(m.login).toHaveBeenCalledWith("project");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ username: "admin", password: "unit-only-value" });
  });
});
