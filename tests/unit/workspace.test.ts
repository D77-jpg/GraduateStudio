import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROJECT_ID_PATTERN,
  WorkspacePathError,
  ensureProjectDir,
  getWorkspaceRoot,
  resolveProjectDir,
  safeJoin,
} from "@/server/workspace/paths";

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gs-workspace-"));
}

describe("getWorkspaceRoot", () => {
  it("uses WORKSPACE_ROOT when provided", () => {
    const root = getWorkspaceRoot({ WORKSPACE_ROOT: path.join(os.tmpdir(), "ws") });
    expect(root).toBe(path.resolve(os.tmpdir(), "ws"));
  });

  it("falls back to .workspace in cwd", () => {
    const root = getWorkspaceRoot({});
    expect(root).toBe(path.resolve(process.cwd(), ".workspace"));
  });

  it("treats blank WORKSPACE_ROOT as unset", () => {
    const root = getWorkspaceRoot({ WORKSPACE_ROOT: "   " });
    expect(root).toBe(path.resolve(process.cwd(), ".workspace"));
  });
});

describe("resolveProjectDir", () => {
  it("resolves a valid project id under the root", () => {
    const root = makeTempRoot();
    expect(resolveProjectDir("proj-1", root)).toBe(path.resolve(root, "proj-1"));
  });

  it("rejects invalid project ids", () => {
    const root = makeTempRoot();
    for (const bad of ["../escape", "a/b", "..", "", "a".repeat(65), "空格 id"]) {
      expect(() => resolveProjectDir(bad, root)).toThrow(WorkspacePathError);
    }
  });
});

describe("ensureProjectDir", () => {
  it("creates the project directory", () => {
    const root = makeTempRoot();
    const dir = ensureProjectDir("proj-1", root);
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe("safeJoin", () => {
  it("joins relative segments inside the base", () => {
    const root = makeTempRoot();
    expect(safeJoin(root, "src", "app.ts")).toBe(path.resolve(root, "src", "app.ts"));
  });

  it("allows inner .. that stay inside the base", () => {
    const root = makeTempRoot();
    expect(safeJoin(root, "src", "..", "app.ts")).toBe(path.resolve(root, "app.ts"));
  });

  it("rejects traversal escaping the base", () => {
    const root = makeTempRoot();
    expect(() => safeJoin(root, "..", "escape")).toThrow(WorkspacePathError);
    expect(() => safeJoin(root, "src", "..", "..", "escape")).toThrow(WorkspacePathError);
  });

  it("rejects absolute paths outside the base", () => {
    const root = makeTempRoot();
    expect(() => safeJoin(root, path.resolve(os.tmpdir(), "elsewhere"))).toThrow(
      WorkspacePathError,
    );
  });
});

describe("PROJECT_ID_PATTERN", () => {
  it("accepts safe ids", () => {
    expect(PROJECT_ID_PATTERN.test("proj-1")).toBe(true);
    expect(PROJECT_ID_PATTERN.test("my_graduation_2026")).toBe(true);
  });

  it("rejects unsafe ids", () => {
    expect(PROJECT_ID_PATTERN.test("../x")).toBe(false);
    expect(PROJECT_ID_PATTERN.test("a b")).toBe(false);
    expect(PROJECT_ID_PATTERN.test("中文名")).toBe(false);
  });
});
