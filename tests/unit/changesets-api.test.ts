import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), accept: vi.fn(), reject: vi.fn(), restore: vi.fn(), undo: vi.fn(), tasks:vi.fn(), checkpoint:vi.fn(), reconcile:vi.fn(), verify:vi.fn() }));
vi.mock("@/server/db",()=>({db:{agentTask:{findMany:mocks.tasks}}}));
vi.mock("@/server/agents/codex-checkpoint",()=>({loadCodexCheckpoint:mocks.checkpoint}));
vi.mock("@/server/agents/codex-review",()=>({reconcileCodexReview:mocks.reconcile}));
vi.mock("@/server/agents/codex-post-apply",()=>({startCodexPostApplyVerification:mocks.verify}));
vi.mock("@/server/auth", () => ({ auth: mocks.auth }));
vi.mock("@/server/changesets", () => ({
  acceptChangeSet: mocks.accept, rejectChangeSet: mocks.reject, restoreChangeSet: mocks.restore,
  undoLatestChangeSet: mocks.undo, listChangeSets: vi.fn(),
  ChangeSetAccessError: class extends Error {}, ChangeSetStateError: class extends Error {},
}));
vi.mock("@/server/api-helpers", () => ({
  jsonError: (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status }),
  handleRouteError: () => Response.json({}, { status: 500 }),
}));
import { POST, PUT } from "@/app/api/projects/[id]/changesets/route";
import { ChangeSetAccessError, ChangeSetStateError } from "@/server/changesets";
const call = (method: "POST" | "PUT", body: unknown) => (method === "POST" ? POST : PUT)(
  new Request("http://localhost/api/projects/url-project/changesets", { method, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: "url-project" }) },
);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "user" } });
  mocks.tasks.mockResolvedValue([]);
});
describe("changeset route guards", () => {
  it("starts verification only for the accepted task proposal",async()=>{
    mocks.accept.mockResolvedValue({id:"set"});mocks.tasks.mockResolvedValue([{id:"task"}]);
    mocks.checkpoint.mockResolvedValue({pendingChangeSetId:"set"});mocks.verify.mockResolvedValue(true);
    const response=await call("POST",{action:"accept",changeSetId:"set"});
    expect((await response.json()).verification).toBe("started");
    expect(mocks.reconcile).toHaveBeenCalledWith("url-project","task");
    expect(mocks.verify).toHaveBeenCalledWith("url-project","task","user");
  });
  it("keeps accepted files successful when verification cannot start",async()=>{
    mocks.accept.mockResolvedValue({id:"set"});mocks.tasks.mockResolvedValue([{id:"task"}]);
    mocks.checkpoint.mockResolvedValue({pendingChangeSetId:"set"});mocks.verify.mockRejectedValue(new Error("busy"));
    const response=await call("POST",{action:"accept",changeSetId:"set"});expect(response.status).toBe(200);
    expect((await response.json()).verification).toBe("not_started");
  });
  it.each(["accept", "reject", "restore"])("passes URL project into %s ownership lookup", async (action) => {
    const operation = action === "accept" ? mocks.accept : action === "reject" ? mocks.reject : mocks.restore;
    operation.mockResolvedValue({ id: "set" });
    const response = await call(action === "restore" ? "PUT" : "POST", { action, changeSetId: "set" });
    expect(response.status).toBe(200);
    expect(operation).toHaveBeenCalledWith("set", "user", "url-project");
  });
  it.each(["accept", "reject", "restore"])("returns 404 for cross-project %s", async (action) => {
    const operation = action === "accept" ? mocks.accept : action === "reject" ? mocks.reject : mocks.restore;
    operation.mockRejectedValue(new ChangeSetAccessError("not owned by URL project"));
    expect((await call(action === "restore" ? "PUT" : "POST", { action, changeSetId: "foreign-set" })).status).toBe(404);
  });
  it("returns actionable conflict instead of 500", async () => {
    mocks.accept.mockRejectedValue(new ChangeSetStateError("baseline diverged"));
    const response = await call("POST", { action: "accept", changeSetId: "set" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "conflict", message: "baseline diverged" } });
  });
  it("keeps undo scoped to URL project", async () => {
    expect((await call("POST", { action: "undo" })).status).toBe(200);
    expect(mocks.undo).toHaveBeenCalledWith("url-project", "user");
  });
  it("requires authentication for every mutation", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await call("POST", { action: "accept", changeSetId: "set" })).status).toBe(401);
    expect((await call("PUT", { changeSetId: "set" })).status).toBe(401);
    expect(mocks.accept).not.toHaveBeenCalled();
    expect(mocks.restore).not.toHaveBeenCalled();
  });
});
