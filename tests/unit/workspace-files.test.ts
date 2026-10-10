import { describe, expect, it } from "vitest";
import { normalizeRelPath, WorkspaceFileError } from "@/server/workspace/files";
import { filterFilesByName } from "@/server/workspace/search";
import { resolveAction } from "@/server/changesets";
import type { FileNodeDto } from "@/server/workspace/files";

describe("normalizeRelPath", () => {
  it("normalizes separators and leading slashes", () => {
    expect(normalizeRelPath("src\\app\\main.tsx")).toBe("src/app/main.tsx");
    expect(normalizeRelPath("/src/main.tsx")).toBe("src/main.tsx");
  });

  it("rejects traversal and protected dirs", () => {
    expect(() => normalizeRelPath("../escape")).toThrow(WorkspaceFileError);
    expect(() => normalizeRelPath("a/../../b")).toThrow(WorkspaceFileError);
    expect(() => normalizeRelPath("node_modules/x/index.js")).toThrow(WorkspaceFileError);
    expect(() => normalizeRelPath(".git/config")).toThrow(WorkspaceFileError);
    expect(() => normalizeRelPath("")).toThrow(WorkspaceFileError);
  });
});

describe("resolveAction", () => {
  it("returns create when file does not exist", () => {
    expect(resolveAction(null, "new content")).toBe("create");
  });

  it("returns null when content unchanged", () => {
    expect(resolveAction("same", "same")).toBeNull();
  });

  it("returns modify when content changed", () => {
    expect(resolveAction("old", "new")).toBe("modify");
  });
});

describe("filterFilesByName", () => {
  const nodes: FileNodeDto[] = [
    { path: "src/main.tsx", name: "main.tsx", type: "file" },
    { path: "src/App.tsx", name: "App.tsx", type: "file" },
    { path: "src", name: "src", type: "dir" },
  ];

  it("matches by name substring case-insensitively, files only", () => {
    expect(filterFilesByName(nodes, "main").map((n) => n.path)).toEqual(["src/main.tsx"]);
    expect(filterFilesByName(nodes, "APP").map((n) => n.path)).toEqual(["src/App.tsx"]);
    expect(filterFilesByName(nodes, "src").map((n) => n.type)).not.toContain("dir");
  });

  it("returns empty for blank query", () => {
    expect(filterFilesByName(nodes, "  ")).toEqual([]);
  });
});
