import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ paths: vi.fn(), read: vi.fn() }));
vi.mock("@/server/db", () => ({
  db: {
    project: { findFirst: vi.fn(async () => ({ name: "project" })) },
    requirement: { findUnique: vi.fn(async () => null) },
    changeSet: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("@/server/projects", () => ({
  toProjectDto: () => ({ name: "project", type: "web", techStack: [], goals: [] }),
}));
vi.mock("@/server/architecture", () => ({ getArchitecture: vi.fn(async () => null) }));
vi.mock("@/server/workspace/search", () => ({
  listProjectFilePaths: mocks.paths,
  isTextFilePath: () => true,
}));
vi.mock("@/server/workspace/files", () => ({ readFileContent: mocks.read }));
import { buildCodingContext } from "@/server/agents/context";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.paths.mockReturnValue([]);
  mocks.read.mockImplementation((_project, _user, path) => ({
    path,
    content: `content:${path}`,
    truncated: false,
  }));
});

describe("coding context bounds and completeness", () => {
  it("reads all 24 selected files, rather than the previous five", async () => {
    const paths = Array.from({ length: 24 }, (_, i) => `file${i}.ts`);
    const context = await buildCodingContext("p", "u", paths);
    expect(mocks.read).toHaveBeenCalledTimes(24);
    expect(context.selectedFilesText).toContain("content:file23.ts");
  });
  it("prioritizes required rewrite files before optional selected files", async () => {
    const paths = Array.from({ length: 24 }, (_, i) => `optional${i}.ts`);
    const context = await buildCodingContext("p", "u", paths, {
      requiredFullFilePaths: ["required.ts"],
    });
    expect(mocks.read.mock.calls[0][2]).toBe("required.ts");
    expect(context.selectedFilesText).toContain("content:required.ts");
    expect(mocks.read).toHaveBeenCalledTimes(25);
  });
  it("automatically reads prioritized planning files without an explicit selection", async () => {
    mocks.paths.mockReturnValue([
      "README.md",
      "src/api/users.ts",
      "package.json",
      "prisma/schema.prisma",
    ]);
    await buildCodingContext("p", "u", [], { autoSelectPlanningFiles: true });
    expect(mocks.read.mock.calls.map((call) => call[2])).toEqual([
      "package.json",
      "prisma/schema.prisma",
      "src/api/users.ts",
      "README.md",
    ]);
  });
  it("fails on hidden underlying read truncation of a required file", async () => {
    mocks.read.mockReturnValue({ path: "large.ts", content: "partial", truncated: true });
    await expect(
      buildCodingContext("p", "u", [], { requiredFullFilePaths: ["large.ts"] }),
    ).rejects.toThrow("禁止");
  });
  it("fails rather than silently skipping a missing required file", async () => {
    mocks.read.mockImplementation(() => {
      throw new Error("missing");
    });
    await expect(
      buildCodingContext("p", "u", [], { requiredFullFilePaths: ["missing.ts"] }),
    ).rejects.toThrow("无法读取");
  });
  it("does not clip complete originals at the retired total-character budget", async () => {
    mocks.read.mockReturnValue({ content: "x".repeat(80_000), truncated: false });
    const result = await buildCodingContext("p", "u", [], {
      requiredFullFilePaths: ["a.ts", "b.ts", "c.ts", "d.ts"],
    });
    expect(result.selectedFilesText.length).toBeGreaterThan(320_000);
    expect(result.selectedFilesText).not.toContain("截断");
  });
});
