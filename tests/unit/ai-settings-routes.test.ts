import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST, DELETE } from "@/app/api/settings/ai/route";
import { POST as TEST } from "@/app/api/settings/ai/test/route";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { aiConfigStore } from "@/server/ai/config-store";
import { generateText } from "ai";
vi.mock("@/server/auth", () => ({ auth: vi.fn() }));
vi.mock("@/server/db", () => ({
  db: { user: { findFirst: vi.fn(), findUnique: vi.fn() }, agentTask: { findFirst: vi.fn() } },
}));
vi.mock("ai", () => ({ generateText: vi.fn() }));
const body = {
  provider: "openai",
  model: "test-model",
  baseURL: "https://api.example.com/v1",
  apiKey: "private-test-key",
};
function request(data: unknown = body, origin = "http://localhost") {
  return new Request("http://localhost/api/settings/ai", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(data),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AI_CONFIG_ADMIN_EMAIL", "");
  vi.mocked(auth).mockResolvedValue({ user: { id: "owner" } } as never);
  vi.mocked(db.user.findFirst).mockResolvedValue({ id: "owner" } as never);
  vi.mocked(db.agentTask.findFirst).mockResolvedValue(null);
  vi.spyOn(aiConfigStore, "read").mockReturnValue(null);
  vi.spyOn(aiConfigStore, "readProfiles").mockReturnValue({ activeProfileId: null, profiles: [] });
  vi.spyOn(aiConfigStore, "activate").mockImplementation(() => {});
  vi.spyOn(aiConfigStore, "deleteProfile").mockImplementation(() => {});
  vi.spyOn(aiConfigStore, "save").mockImplementation(() => {});
  vi.spyOn(aiConfigStore, "reset").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe("settings routes", () => {
  it("requires authentication for reading and all mutations", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    expect((await GET()).status).toBe(401);
    expect((await POST(request())).status).toBe(401);
    expect((await DELETE(request())).status).toBe(401);
    expect((await TEST(request())).status).toBe(401);
  });
  it("authenticated nonowner reads safely but cannot mutate or probe", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "other" } } as never);
    const read = await (await GET()).json();
    expect(read.config.canEdit).toBe(false);
    expect(read.config).not.toHaveProperty("apiKey");
    expect((await POST(request())).status).toBe(403);
    expect((await DELETE(request())).status).toBe(403);
    expect((await TEST(request())).status).toBe(403);
    expect(aiConfigStore.save).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });
  it("blocks mutation while global active task exists", async () => {
    vi.mocked(db.agentTask.findFirst).mockResolvedValue({ id: "paused-other-user-task" } as never);
    expect((await POST(request())).status).toBe(409);
    expect((await DELETE(request())).status).toBe(409);
    expect(aiConfigStore.save).not.toHaveBeenCalled();
  });
  it("rejects cross-origin requests and invalid payload without persistence", async () => {
    expect((await POST(request(body, "https://evil.test"))).status).toBe(403);
    expect((await TEST(request(body, "https://evil.test"))).status).toBe(403);
    expect((await POST(request({ ...body, baseURL: "http://public.test" }))).status).toBe(400);
    expect(aiConfigStore.save).not.toHaveBeenCalled();
  });
  it("saves explicit draft without testing, responds sanitized", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(aiConfigStore.save).toHaveBeenCalledWith(body);
    expect(generateText).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain(body.apiKey);
  });
  it("supports create, activate and delete contracts without connecting", async () => {
    const profileId = "b6bafbe2-7cca-4c6f-a016-4130b4f34613";
    expect(
      (await POST(request({ ...body, createNew: true, name: "Gateway", activate: false }))).status,
    ).toBe(200);
    expect(aiConfigStore.save).toHaveBeenCalledWith(body, {
      createNew: true,
      name: "Gateway",
      activate: false,
    });
    expect((await POST(request({ action: "activate", profileId }))).status).toBe(200);
    expect(aiConfigStore.activate).toHaveBeenCalledWith(profileId);
    expect((await POST(request({ action: "delete", profileId }))).status).toBe(200);
    expect(aiConfigStore.deleteProfile).toHaveBeenCalledWith(profileId);
    expect(generateText).not.toHaveBeenCalled();
    expect((await POST(request({ action: "activate", profileId: "invalid" }))).status).toBe(400);
    expect((await POST(request({ ...body, profileId, createNew: true }))).status).toBe(400);
  });
  it("returns sanitized profile lists and reuses a selected profile only for the same endpoint", async () => {
    const profileId = "b6bafbe2-7cca-4c6f-a016-4130b4f34613";
    vi.mocked(aiConfigStore.readProfiles).mockReturnValue({
      activeProfileId: profileId,
      profiles: [{ ...body, provider: "openai", id: profileId, name: "Gateway" }],
    });
    vi.mocked(aiConfigStore.read).mockReturnValue({ ...body, provider: "openai" });
    const data = await (await GET()).json();
    expect(data.activeProfileId).toBe(profileId);
    expect(data.profiles).toEqual([
      {
        id: profileId,
        name: "Gateway",
        provider: "openai",
        model: body.model,
        baseURL: body.baseURL,
        hasApiKey: true,
      },
    ]);
    expect(JSON.stringify(data)).not.toContain(body.apiKey);
    const { apiKey, ...blank } = body;
    void apiKey;
    expect((await POST(request({ ...blank, profileId }))).status).toBe(200);
    expect(
      (await POST(request({ ...blank, profileId, baseURL: "https://changed.test/v1" }))).status,
    ).toBe(400);
    expect((await POST(request({ ...blank, createNew: true }))).status).toBe(400);
    expect(
      (await TEST(request({ ...blank, profileId, baseURL: "https://changed.test/v1" }))).status,
    ).toBe(400);
    expect(generateText).not.toHaveBeenCalled();
  });
  it("DELETE resets only override", async () => {
    vi.stubEnv("OPENAI_API_KEY", "env-private");
    const response = await DELETE(request());
    expect(response.status).toBe(200);
    expect(aiConfigStore.reset).toHaveBeenCalledOnce();
    const data = await response.json();
    expect(data.config.source).toBe("environment");
    expect(data.config.hasApiKey).toBe(true);
  });
  it("tests unsaved draft without saving and masks failures", async () => {
    vi.mocked(generateText).mockResolvedValue({ text: "private upstream" } as never);
    const response = await TEST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      tested: true,
      durationMs: expect.any(Number),
    });
    expect(aiConfigStore.save).not.toHaveBeenCalled();
    vi.mocked(generateText).mockRejectedValue(
      new Error("private-test-key upstream https://secret"),
    );
    const failure = await TEST(request());
    expect(failure.status).toBe(502);
    expect(JSON.stringify(await failure.json())).not.toContain("private");
  });
  it("corrupt saved configuration exposes only recovery metadata", async () => {
    vi.mocked(aiConfigStore.read).mockImplementation(() => {
      throw new Error("secret corrupted");
    });
    const response = await GET();
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data).toMatchObject({
      configErrorCode: "config_unavailable",
      configError: expect.any(String),
      config: { canEdit: true, hasApiKey: false, source: "saved" },
    });
    expect(JSON.stringify(data)).not.toContain("secret");
  });
});
