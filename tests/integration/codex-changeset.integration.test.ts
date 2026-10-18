import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Opt-in, offline integration verification (no model invocation):
 * PowerShell:
 *   $env:CODEX_CHANGESET_INTEGRATION='1'; pnpm exec vitest run tests/integration/codex-changeset.integration.test.ts --reporter=verbose
 *
 * Never import the application's DB singleton. Both Prisma and the schema bootstrap
 * receive the same explicit, newly allocated SQLite URL, regardless of .env.
 * Only the DB binding and workspace root are substituted; Prisma operations,
 * ownership relation filters, ChangeSet logic, file IO and activity logging are real.
 */
const integration = process.env.CODEX_CHANGESET_INTEGRATION === "1" ? describe : describe.skip;
const BEFORE = "你好，旧版本\n";
const AFTER = "你好，Codex隔离验证成功\n";
const FILE = "hello.txt";

integration("Codex ChangeSet with real isolated Prisma/SQLite and workspace", () => {
  let temporaryRoot: string | undefined;
  let workspaceRoot: string;
  let client: PrismaClient | undefined;
  let service: typeof import("@/server/changesets");
  let ownerId: string;
  let otherUserId: string;
  let projectId: string;
  let filePath: string;

  beforeAll(async () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-changeset-integration-"));
    workspaceRoot = path.join(temporaryRoot, "workspace");
    fs.mkdirSync(workspaceRoot);
    const databasePath = path.join(temporaryRoot, "integration.sqlite");
    const datasourceUrl = `file:${databasePath.replaceAll("\\", "/")}`;
    expect(fs.existsSync(databasePath)).toBe(false);
    expect(path.dirname(databasePath)).toBe(temporaryRoot);

    const require = createRequire(import.meta.url);
    const bootstrap = spawnSync(
      process.execPath,
      [
        require.resolve("prisma/build/index.js"),
        "db",
        "push",
        "--schema",
        path.resolve("prisma/schema.prisma"),
        "--skip-generate",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: datasourceUrl },
        stdio: "inherit",
        timeout: 60_000,
      },
    );
    if (bootstrap.error) throw bootstrap.error;
    if (bootstrap.status !== 0) {
      throw new Error(
        `Temporary SQLite schema bootstrap failed: exit=${bootstrap.status}, signal=${bootstrap.signal}`,
      );
    }
    expect(fs.existsSync(databasePath)).toBe(true);
    client = new PrismaClient({ datasourceUrl });
    await client.$connect();
    const databases =
      await client.$queryRawUnsafe<Array<{ name: string; file: string }>>("PRAGMA database_list");
    expect(path.resolve(databases.find((entry) => entry.name === "main")!.file)).toBe(databasePath);

    // Register before importing the service, so src/server/db.ts is never evaluated.
    vi.doMock("@/server/db", () => ({ db: client! }));
    vi.doMock("@/server/workspace/paths", async () => {
      const actual = await vi.importActual<typeof import("@/server/workspace/paths")>(
        "@/server/workspace/paths",
      );
      return {
        ...actual,
        getWorkspaceRoot: () => workspaceRoot,
        resolveProjectDir: (id: string) => actual.resolveProjectDir(id, workspaceRoot),
        ensureProjectDir: (id: string) => actual.ensureProjectDir(id, workspaceRoot),
      };
    });
    service = await import("@/server/changesets");
    expect(await client.user.count()).toBe(0);
    expect(await client.project.count()).toBe(0);
    ownerId = (await client.user.create({ data: { name: "Isolated owner" } })).id;
    otherUserId = (await client.user.create({ data: { name: "Isolated non-owner" } })).id;
    console.info(
      `[codex-changeset integration] real SQLite=${databasePath}; workspace=${workspaceRoot}; no model calls`,
    );
  }, 90_000);

  beforeEach(async () => {
    projectId = (
      await client!.project.create({
        data: { name: "Disposable Codex fixture", userId: ownerId },
      })
    ).id;
    const projectDirectory = path.join(workspaceRoot, projectId);
    fs.mkdirSync(projectDirectory);
    filePath = path.join(projectDirectory, FILE);
    fs.writeFileSync(filePath, Buffer.from(BEFORE, "utf8"));
  });

  afterAll(async () => {
    try {
      await client?.$disconnect();
    } finally {
      vi.doUnmock("@/server/db");
      vi.doUnmock("@/server/workspace/paths");
      if (temporaryRoot) {
        fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        expect(fs.existsSync(temporaryRoot)).toBe(false);
        console.info(
          "[codex-changeset integration] Prisma disconnected; temporary DB/workspace removed",
        );
      }
    }
  });

  const propose = (
    additionalChanges: Array<{ path: string; action: "create"; content: string }> = [],
  ) =>
    service.createPendingChangeSet({
      projectId,
      userId: ownerId,
      title: "Codex isolated UTF-8 fixture",
      summary: "Previously live-model-validated fixture; replay only, no inference",
      plan: [{ action: "modify", path: FILE, reason: "Exact UTF-8 replacement" }],
      expectedBaseline: { [FILE]: BEFORE },
      changes: [{ path: FILE, action: "modify", content: AFTER }, ...additionalChanges],
    });

  it("persists a pending immutable baseline without writing, then accepts exact UTF-8 bytes", async () => {
    const pending = await propose();
    expect(pending.status).toBe("pending");
    expect(pending.source).toBe("ai");
    expect(pending.appliedAt).toBeNull();
    expect(fs.readFileSync(filePath)).toEqual(Buffer.from(BEFORE, "utf8"));
    const stored = await client!.changeSet.findUniqueOrThrow({
      where: { id: pending.id },
      include: { changes: true },
    });
    expect(stored.status).toBe("pending");
    expect(stored.appliedAt).toBeNull();
    expect(stored.changes).toHaveLength(1);
    expect(stored.changes[0]).toMatchObject({
      path: FILE,
      action: "modify",
      beforeContent: BEFORE,
      afterContent: AFTER,
    });

    const accepted = await service.acceptChangeSet(pending.id, ownerId, projectId);
    expect(accepted.status).toBe("accepted");
    expect(accepted.appliedAt).not.toBeNull();
    expect(fs.readFileSync(filePath)).toEqual(Buffer.from(AFTER, "utf8"));
    const persisted = await client!.changeSet.findUniqueOrThrow({
      where: { id: pending.id },
      include: { changes: true },
    });
    expect(persisted.status).toBe("accepted");
    expect(persisted.appliedAt).toBeInstanceOf(Date);
    expect(persisted.changes[0].beforeContent).toBe(BEFORE);
    expect(persisted.changes[0].afterContent).toBe(AFTER);
    expect(await client!.activityLog.count({ where: { projectId } })).toBe(2);
    await expect(service.acceptChangeSet(pending.id, ownerId, projectId)).rejects.toBeInstanceOf(
      service.ChangeSetStateError,
    );
    expect(fs.readFileSync(filePath)).toEqual(Buffer.from(AFTER, "utf8"));
  });

  it("denies acceptance after a manual edit without overwriting or creating any proposal files", async () => {
    const extraPath = path.join(workspaceRoot, projectId, "must-not-be-created.txt");
    const pending = await propose([
      { path: "must-not-be-created.txt", action: "create", content: "must not write\n" },
    ]);
    const manual = "你好，用户手动编辑，请保留\n";
    fs.writeFileSync(filePath, Buffer.from(manual, "utf8"));
    await expect(service.acceptChangeSet(pending.id, ownerId, projectId)).rejects.toBeInstanceOf(
      service.ChangeSetStateError,
    );
    expect(fs.readFileSync(filePath)).toEqual(Buffer.from(manual, "utf8"));
    expect(fs.existsSync(extraPath)).toBe(false);
    const stored = await client!.changeSet.findUniqueOrThrow({
      where: { id: pending.id },
      include: { changes: true },
    });
    expect(stored.status).toBe("pending");
    expect(stored.appliedAt).toBeNull();
    expect(stored.changes.find((change) => change.path === FILE)?.beforeContent).toBe(BEFORE);
    expect(await client!.activityLog.count({ where: { projectId } })).toBe(1);
  });

  it("rejects a stale generation baseline before inserting ChangeSet or Change rows", async () => {
    const manual = "你好，生成期间手动编辑\n";
    fs.writeFileSync(filePath, Buffer.from(manual, "utf8"));
    const changesBefore = await client!.change.count();
    await expect(propose()).rejects.toBeInstanceOf(service.ChangeSetStateError);
    expect(fs.readFileSync(filePath)).toEqual(Buffer.from(manual, "utf8"));
    expect(await client!.changeSet.count({ where: { projectId } })).toBe(0);
    expect(await client!.change.count()).toBe(changesBefore);
    expect(await client!.activityLog.count({ where: { projectId } })).toBe(0);
  });

  it("enforces actual DB ownership and URL project equality before any disk write", async () => {
    const pending = await propose();
    const otherProject = await client!.project.create({
      data: { name: "Other isolated project", userId: ownerId },
    });
    await expect(
      service.acceptChangeSet(pending.id, otherUserId, projectId),
    ).rejects.toBeInstanceOf(service.ChangeSetAccessError);
    await expect(
      service.acceptChangeSet(pending.id, ownerId, otherProject.id),
    ).rejects.toBeInstanceOf(service.ChangeSetAccessError);
    expect(fs.readFileSync(filePath)).toEqual(Buffer.from(BEFORE, "utf8"));
    const stored = await client!.changeSet.findUniqueOrThrow({ where: { id: pending.id } });
    expect(stored.status).toBe("pending");
    expect(stored.appliedAt).toBeNull();
    expect(await client!.activityLog.count({ where: { projectId } })).toBe(1);
  });
});
