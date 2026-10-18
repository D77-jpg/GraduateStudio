import { describe, expect, it } from "vitest";
import { planOutputSchema } from "@/lib/develop";
import {
  assertGenerationPlan,
  assertImplementationCoverage,
  assertSafeGenerationPath,
  assertFullRewriteContext,
  isPlaceholderOnly,
  prioritizePlanningFiles,
} from "@/lib/generation-quality";

const steps = [
  { path: "src/service.ts", action: "modify" as const },
  { path: "src/api.ts", action: "create" as const },
  { path: "old.ts", action: "delete" as const },
];
const changes = steps.map((step) => ({
  ...step,
  content: step.action === "delete" ? "" : "export const value = 42;",
}));

describe("generation acceptance", () => {
  it("accepts exactly planned files in any output order", () => {
    expect(() => assertImplementationCoverage(steps, [...changes].reverse())).not.toThrow();
  });
  it("rejects omissions, extra files, changed actions and duplicate paths", () => {
    expect(() => assertImplementationCoverage(steps, changes.slice(1))).toThrow("遗漏");
    expect(() =>
      assertImplementationCoverage(steps, [...changes, { ...changes[0], path: "extra.ts" }]),
    ).toThrow("计划外");
    expect(() =>
      assertImplementationCoverage(steps, [
        { ...changes[0], action: "create" },
        ...changes.slice(1),
      ]),
    ).toThrow("动作");
    expect(() => assertImplementationCoverage(steps, [...changes, changes[0]])).toThrow("重复");
    expect(() =>
      assertGenerationPlan([
        { path: "A.ts", action: "create" },
        { path: "a.ts", action: "modify" },
      ]),
    ).toThrow("重复");
  });
  it.each([
    "",
    " \n\t",
    "// TODO: implement",
    "/* implementation omitted */",
    "…",
    "TODO",
    "def run():\n    pass",
    "export function run() { throw new Error('Not implemented'); }",
  ])("rejects empty/placeholder-only create or modify: %s", (content) => {
    expect(() =>
      assertImplementationCoverage(steps, [{ ...changes[0], content }, ...changes.slice(1)]),
    ).toThrow("占位");
  });
  it("requires truly empty delete content", () => {
    expect(() =>
      assertImplementationCoverage(steps, [
        ...changes.slice(0, 2),
        { ...changes[2], content: " " },
      ]),
    ).toThrow("必须为空");
  });
  it("does not reject useful code containing TODOs or valid unimplemented-error handling", () => {
    expect(isPlaceholderOnly("// TODO: improve caching\nexport const value = 42;")).toBe(false);
    expect(
      isPlaceholderOnly(
        "export function run(value: string) { if (!value) throw new Error('Not implemented'); return value; }",
      ),
    ).toBe(false);
    expect(isPlaceholderOnly("export const items = [];")).toBe(false);
  });
  it.each([
    "/abs.ts",
    "../x",
    "a/../b",
    "C:/file.ts",
    "a\\file.ts",
    "a//b",
    ".git/config",
    "NODE_MODULES/a",
    "a/./b",
    "a\u0000b",
    "a/NUL.txt",
    " a.ts",
    "a.ts ",
    "a./b",
  ])("rejects unsafe path %s", (path) => {
    expect(() => assertSafeGenerationPath(path)).toThrow();
  });
  it("accepts ordinary framework and migration paths", () => {
    for (const path of [
      "src/app/[id]/page.tsx",
      "prisma/schema.prisma",
      "migrations/001_init.sql",
      ".env.example",
    ]) {
      expect(() => assertSafeGenerationPath(path)).not.toThrow();
    }
  });
  it("supports plans beyond the former fixed file count", () => {
    const plan = {
      title: "完整计划",
      summary: "实现完整业务闭环并验证",
      risks: "",
      steps: Array.from({ length: 24 }, (_, i) => ({
        path: `src/file${i}.ts`,
        action: "create",
        reason: "独立职责",
      })),
    };
    expect(planOutputSchema.safeParse(plan).success).toBe(true);
    expect(
      planOutputSchema.safeParse({
        ...plan,
        steps: [...plan.steps, { ...plan.steps[0], path: "extra.ts" }],
      }).success,
    ).toBe(true);
    expect(() =>
      assertGenerationPlan(
        Array.from({ length: 100 }, (_, i) => ({ path: `file${i}.ts`, action: "create" })),
      ),
    ).not.toThrow();
  });
});

describe("non-executable comment content", () => {
  it("accepts meaningful comment-only documentation/config but rejects explicit placeholders", () => {
    for (const [path, content] of [
      [".gitignore", "# Project-specific ignore rules"],
      ["LICENSE", "/* Copyright 2026 */"],
      ["README.md", "# Project documentation"],
    ]) {
      expect(() =>
        assertImplementationCoverage(
          [{ path, action: "create" }],
          [{ path, action: "create", content }],
        ),
      ).not.toThrow();
    }
    expect(() =>
      assertImplementationCoverage(
        [{ path: "README.md", action: "create" }],
        [{ path: "README.md", action: "create", content: "<!-- TODO implement docs -->" }],
      ),
    ).toThrow("占位");
  });
});

describe("rewrite context safeguards", () => {
  it("requires an existing complete text file without artificial size budgets", () => {
    expect(() => assertFullRewriteContext("a.ts", null, 100)).toThrow("无法读取");
    expect(() =>
      assertFullRewriteContext("a.ts", { content: "small", truncated: true }, 100),
    ).toThrow("禁止");
    expect(() =>
      assertFullRewriteContext("a.ts", { content: "a\u0000", truncated: false }, 100),
    ).toThrow("禁止");
    expect(() =>
      assertFullRewriteContext("a.ts", { content: "long", truncated: false }, 3),
    ).not.toThrow();
    expect(() =>
      assertFullRewriteContext("a.ts", { content: "x".repeat(320_000), truncated: false }, 1),
    ).not.toThrow();
    expect(() =>
      assertFullRewriteContext("a.ts", { content: "full", truncated: false }, 4),
    ).not.toThrow();
  });
  it("prioritizes manifest, schema, entry and API before unrelated files", () => {
    expect(
      prioritizePlanningFiles([
        "README.md",
        "src/api/users.ts",
        "src/main.ts",
        "prisma/schema.prisma",
        "package.json",
      ]),
    ).toEqual([
      "package.json",
      "prisma/schema.prisma",
      "src/main.ts",
      "src/api/users.ts",
      "README.md",
    ]);
  });
});
