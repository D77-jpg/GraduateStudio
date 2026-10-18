import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findFirst: vi.fn(), update: vi.fn(), create: vi.fn(), activity: vi.fn() }));
vi.mock("@/server/db", () => ({ db: { changeSet: {
  findFirst: mocks.findFirst, update: mocks.update, create: mocks.create,
} } }));
vi.mock("@/server/activity", () => ({ logActivity: mocks.activity }));
import {
  acceptChangeSet, rejectChangeSet, restoreChangeSet, recordManualChange, createPendingChangeSet,
  ChangeSetAccessError, ChangeSetStateError,
} from "@/server/changesets";

let root: string;
let rows: ReturnType<typeof makeRow>[];
function makeRow(id = "set", projectId = "project") {
  return {
    id, projectId, title: "Pending", summary: "", plan: "[]", source: "ai",
    status: "pending", createdAt: new Date(), appliedAt: null as Date | null,
    changes: [
      { id: `${id}-1`, changeSetId: id, path: "a.txt", action: "modify", beforeContent: "before", afterContent: "after" },
      { id: `${id}-2`, changeSetId: id, path: "b.txt", action: "create", beforeContent: null as string | null, afterContent: "new" },
    ],
  };
}
const disk = (file: string, project = "project") => path.join(root, project, file);
const read = (file: string) => fs.readFileSync(disk(file), "utf8");
function seed(project = "project") {
  fs.mkdirSync(path.join(root, project), { recursive: true });
  fs.writeFileSync(disk("a.txt", project), "before");
}
beforeEach(() => {
  vi.resetAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "changeset-guard-"));
  vi.stubEnv("WORKSPACE_ROOT", root);
  rows = [makeRow()];
  seed();
  mocks.findFirst.mockImplementation(async ({ where }) => {
    const row = rows.find((r) => r.id === where.id && (!where.projectId || r.projectId === where.projectId) && where.project?.userId === "user");
    return row ? structuredClone(row) : null;
  });
  mocks.update.mockImplementation(async ({ where, data }) => {
    const row = rows.find((r) => r.id === where.id)!;
    Object.assign(row, data);
    return structuredClone(row);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("immutable proposal baseline", () => {
  const propose = (expectedBaseline?: Record<string, string>) => createPendingChangeSet({
    projectId: "project", userId: "user", title: "proposal", summary: "", plan: [],
    changes: [
      { path: "a.txt", action: "modify", content: "generated" },
      { path: "b.txt", action: "create", content: "new" },
    ],
    ...(expectedBaseline === undefined ? {} : { expectedBaseline }),
  });
  beforeEach(() => {
    mocks.create.mockImplementation(async ({ data }) => ({
      ...makeRow(), ...data,
      changes: data.changes.create.map((change: object, index: number) => ({ id: String(index), ...change })),
    }));
  });
  it("stores the provided immutable baseline without changing default callers", async () => {
    expect((await propose({ "a.txt": "before" })).changes[0].beforeContent).toBe("before");
    fs.writeFileSync(disk("a.txt"), "new live content");
    expect((await propose()).changes[0].beforeContent).toBe("new live content");
  });
  it.each(["modified", "deleted", "created", "truncated"])("does not create pending rows when expected baseline is %s", async (kind) => {
    if (kind === "modified") fs.writeFileSync(disk("a.txt"), "concurrent edit");
    if (kind === "deleted") fs.unlinkSync(disk("a.txt"));
    if (kind === "created") fs.writeFileSync(disk("b.txt"), "concurrent create");
    if (kind === "truncated") fs.writeFileSync(disk("a.txt"), "x".repeat(512 * 1024 + 1));
    const baseline = { "a.txt": kind === "truncated" ? "x".repeat(512 * 1024) : "before" };
    await expect(propose(baseline)).rejects.toBeInstanceOf(ChangeSetStateError);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("keeps late edits conflicting rather than refreshing baseline during DB creation", async () => {
    const create = mocks.create.getMockImplementation()!;
    mocks.create.mockImplementationOnce(async (args) => {
      fs.writeFileSync(disk("a.txt"), "late edit");
      return create(args);
    });
    const proposal = await propose({ "a.txt": "before" });
    expect(proposal.changes[0].beforeContent).toBe("before");
    await expect(acceptChangeSet("set", "user")).rejects.toBeInstanceOf(ChangeSetStateError);
    expect(read("a.txt")).toBe("late edit");
  });
  it("uses own keys for special filenames and absence semantics", async () => {
    fs.writeFileSync(disk("__proto__"), "original");
    const baseline = JSON.parse('{"__proto__":"original"}') as Record<string, string>;
    const proposal = await createPendingChangeSet({
      projectId: "project", userId: "user", title: "special", summary: "", plan: [],
      changes: [{ path: "__proto__", action: "modify", content: "updated" }], expectedBaseline: baseline,
    });
    expect(proposal.changes[0].beforeContent).toBe("original");
    await expect(createPendingChangeSet({
      projectId: "project", userId: "user", title: "missing", summary: "", plan: [],
      changes: [{ path: "__proto__", action: "modify", content: "updated" }], expectedBaseline: {},
    })).rejects.toBeInstanceOf(ChangeSetStateError);
  });
});

describe("guarded pending acceptance", () => {
  it("applies create/modify/delete and marks accepted only after writes", async () => {
    fs.writeFileSync(disk("c.txt"), "removed");
    rows[0].changes.push({ id: "delete", changeSetId: "set", path: "c.txt", action: "delete", beforeContent: "removed", afterContent: null! });
    const result = await acceptChangeSet("set", "user", "project");
    expect(result.status).toBe("accepted");
    expect(read("a.txt")).toBe("after");
    expect(read("b.txt")).toBe("new");
    expect(fs.existsSync(disk("c.txt"))).toBe(false);
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it.each(["modified", "deleted", "created", "delete-diverged"])("preflights all files before writing: %s", async (conflict) => {
    if (conflict === "modified") fs.writeFileSync(disk("a.txt"), "manual edit");
    if (conflict === "deleted") fs.unlinkSync(disk("a.txt"));
    if (conflict === "created") fs.writeFileSync(disk("b.txt"), "manual create");
    if (conflict === "delete-diverged") {
      rows[0].changes[1] = { ...rows[0].changes[1], action: "delete", beforeContent: "old", afterContent: null! };
      fs.writeFileSync(disk("b.txt"), "changed");
    }
    const write = vi.spyOn(fs, "writeFileSync");
    await expect(acceptChangeSet("set", "user")).rejects.toBeInstanceOf(ChangeSetStateError);
    expect(write).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(rows[0].status).toBe("pending");
  });

  it("refuses truncated content even when stored prefix matches", async () => {
    const prefix = "x".repeat(512 * 1024);
    fs.writeFileSync(disk("a.txt"), `${prefix}tail`);
    rows[0].changes[0].beforeContent = prefix;
    await expect(acceptChangeSet("set", "user")).rejects.toThrow("文件过大");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(fs.statSync(disk("a.txt")).size).toBe(prefix.length + 4);
  });

  it("rejects directory targets before any write", async () => {
    fs.mkdirSync(disk("b.txt"));
    await expect(acceptChangeSet("set", "user")).rejects.toThrow("路径被占用");
    expect(read("a.txt")).toBe("before");
    expect(fs.statSync(disk("b.txt")).isDirectory()).toBe(true);
  });

  it("rolls back applied and partially-written failing files", async () => {
    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((target, data, options) => {
      realWrite(target, data, options);
      if (String(target) === disk("b.txt") && data === "new") throw new Error("disk failure");
    });
    await expect(acceptChangeSet("set", "user")).rejects.toThrow("disk failure");
    expect(read("a.txt")).toBe("before");
    expect(fs.existsSync(disk("b.txt"))).toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("restores modified/deleted files and removes new files on DB failure", async () => {
    fs.writeFileSync(disk("c.txt"), "removed");
    rows[0].changes.push({ id: "delete", changeSetId: "set", path: "c.txt", action: "delete", beforeContent: "removed", afterContent: null! });
    mocks.update.mockRejectedValueOnce(new Error("DB failure"));
    await expect(acceptChangeSet("set", "user")).rejects.toThrow("DB failure");
    expect(read("a.txt")).toBe("before");
    expect(read("c.txt")).toBe("removed");
    expect(fs.existsSync(disk("b.txt"))).toBe(false);
    expect(rows[0].status).toBe("pending");
    expect(mocks.activity).not.toHaveBeenCalled();
    // Failed mutations release the process mutex.
    expect((await acceptChangeSet("set", "user")).status).toBe("accepted");
  });

  it("continues rollback after compensation failure and reports it", async () => {
    mocks.update.mockRejectedValueOnce(new Error("DB failure"));
    vi.spyOn(fs, "rmSync").mockImplementationOnce(() => { throw new Error("rollback failure"); });
    await expect(acceptChangeSet("set", "user")).rejects.toBeInstanceOf(AggregateError);
    expect(read("a.txt")).toBe("before");
  });

  it("does not undo committed files on post-commit logging failure", async () => {
    mocks.activity.mockRejectedValueOnce(new Error("log failure"));
    await expect(acceptChangeSet("set", "user")).rejects.toThrow("log failure");
    expect(rows[0].status).toBe("accepted");
    expect(read("a.txt")).toBe("after");
  });

  it.each([acceptChangeSet, rejectChangeSet, restoreChangeSet])("requires URL project equality and user ownership", async (operation) => {
    await expect(operation("set", "user", "other-project")).rejects.toBeInstanceOf(ChangeSetAccessError);
    await expect(operation("set", "other-user", "project")).rejects.toBeInstanceOf(ChangeSetAccessError);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(read("a.txt")).toBe("before");
  });

  it("serializes two accepts and a reject with status reloaded under lock", async () => {
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const update = mocks.update.getMockImplementation()!;
    mocks.update.mockImplementationOnce(async (args) => { entered(); await blocked; return update(args); });
    const first = acceptChangeSet("set", "user");
    await started;
    const next = acceptChangeSet("set", "user");
    const rejection = rejectChangeSet("set", "user");
    finish();
    const results = await Promise.allSettled([first, next, rejection]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "rejected"]);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(rows[0].status).toBe("accepted");
  });

  it("reject winning the mutex prevents an overlapping accept from writing", async () => {
    const results = await Promise.allSettled([
      rejectChangeSet("set", "user"), acceptChangeSet("set", "user"),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(rows[0].status).toBe("rejected");
    expect(read("a.txt")).toBe("before");
    expect(fs.existsSync(disk("b.txt"))).toBe(false);
  });

  it("rechecks baselines for overlapping different pending sets after the first accept", async () => {
    rows.push(makeRow("second"));
    const results = await Promise.allSettled([
      acceptChangeSet("set", "user"), acceptChangeSet("second", "user"),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(rows[1].status).toBe("pending");
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(read("a.txt")).toBe("after");
  });

  it("serializes different change sets in one project but not independent projects", async () => {
    rows.push(makeRow("second"), makeRow("independent", "other"));
    seed("other");
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    const update = mocks.update.getMockImplementation()!;
    mocks.update.mockImplementationOnce(async (args) => { entered(); await blocked; return update(args); });
    const first = acceptChangeSet("set", "user");
    await started;
    const second = rejectChangeSet("second", "user");
    const independent = await rejectChangeSet("independent", "user");
    expect(independent.status).toBe("rejected");
    expect(rows[1].status).toBe("pending");
    finish();
    await Promise.all([first, second]);
    expect(rows[1].status).toBe("rejected");
  });

  it("preserves immediate manual save and no-op history semantics", async () => {
    mocks.create.mockImplementation(async ({ data }) => ({
      ...makeRow(), ...data, summary: "", plan: "[]",
      changes: [{ id: "manual", ...data.changes.create }],
    }));
    const saved = await recordManualChange({ projectId: "project", userId: "user", path: "a.txt", content: "manual" });
    expect(saved.source).toBe("manual");
    expect(saved.status).toBe("accepted");
    expect(read("a.txt")).toBe("manual");
    const noOp = await recordManualChange({ projectId: "project", userId: "user", path: "a.txt", content: "manual" });
    expect(noOp.title).toContain("无变化");
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });
});
