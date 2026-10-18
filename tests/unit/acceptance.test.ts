import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectAcceptancePlaceholders,
  isVitestTestScript,
  isNodeTestScript,
  planProjectAcceptance,
  summarizeAcceptance,
  type AcceptanceSnapshot,
} from "@/lib/acceptance";
import {
  ACCEPTANCE_OUTPUT_LIMIT,
  acceptanceSpawnSpec,
  executeAcceptanceCommand,
  inspectAcceptanceProject,
  runProjectAcceptance,
  type AcceptanceExecutor,
} from "@/server/agents/acceptance";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(files: Record<string, string> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acceptance-unit-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  }
  return root;
}
const complete: AcceptanceSnapshot = {
  frontend: {
    directory: "client",
    packageJson: { scripts: { build: "vite build", test: "vitest run" } },
  },
  backend: true,
  backendHasTests: true,
  sources: [],
};
const success: AcceptanceExecutor = async () => ({
  exitCode: 0,
  output: "Tests  2 passed\nTests run: 2, Failures: 0, Errors: 0, Skipped: 0",
  durationMs: 4,
});
const fullFiles = {
  "client/package.json": JSON.stringify(complete.frontend!.packageJson),
  "client/src/App.vue": "<template><div>Working application</div></template>",
  "server/pom.xml": "<project />",
  "server/src/test/java/AppTest.java": "class AppTest {}",
};

describe("acceptance planning", () => {
  it("never accepts empty, skipped-only, or missing-stack checks", () => {
    expect(summarizeAcceptance([])).toBe("blocked");
    expect(
      summarizeAcceptance([{ id: "s", label: "s", status: "skipped", output: "", durationMs: 0 }]),
    ).toBe("blocked");
    const plan = planProjectAcceptance({ backend: false, backendHasTests: false, sources: [] });
    expect(summarizeAcceptance(plan.checks)).toBe("blocked");
    expect(plan.commands).toEqual([]);
  });
  it("blocks no-op build scripts and Vitest no-test overrides", () => {
    const plan = planProjectAcceptance({
      ...complete,
      frontend: {
        directory: "client",
        packageJson: { scripts: { build: "echo passed", test: "vitest --passWithNoTests" } },
      },
    });
    expect(plan.commands.map((command) => command.id)).toEqual(["backend-verify"]);
    expect(plan.checks.filter((check) => check.status === "blocked")).toHaveLength(2);
  });
  it("uses fixed scripts, disables npm lifecycle hooks, and keeps Maven bounded", () => {
    const plan = planProjectAcceptance(complete);
    expect(plan.commands.map((c) => [c.tool, c.args])).toEqual([
      ["npm", ["--ignore-scripts", "run", "build"]],
      ["npm", ["--ignore-scripts", "run", "test", "--", "--run"]],
      ["mvn", ["-B", "-f", "pom.xml", "verify"]],
    ]);
    expect(plan.commands.every((c) => c.timeoutMs > 0 && c.timeoutMs <= 240_000)).toBe(true);
  });
  it("recognizes direct Vitest only, rejecting arbitrary/compound test scripts", () => {
    for (const script of ["vitest", "vitest run", "vitest --coverage", "vitest run --reporter=dot"])
      expect(isVitestTestScript(script)).toBe(true);
    for (const script of [
      "echo vitest",
      "jest",
      "vitest && curl evil",
      "vitest; echo evil",
      "npx vitest",
      "vitest $(whoami)",
      undefined,
    ])
      expect(isVitestTestScript(script)).toBe(false);
    const plan = planProjectAcceptance({
      ...complete,
      frontend: { directory: ".", packageJson: { scripts: { test: "echo vitest" } } },
    });
    expect(plan.checks.filter((c) => c.status === "blocked").map((c) => c.id)).toEqual([
      "frontend-build",
      "frontend-test",
    ]);
    expect(plan.commands.map((c) => c.id)).toEqual(["backend-verify"]);
  });
  it("blocks missing backend tests rather than trusting no-test Maven success", () => {
    expect(planProjectAcceptance({ ...complete, backendHasTests: false }).checks).toContainEqual(
      expect.objectContaining({ id: "backend-tests", status: "blocked" }),
    );
  });
  it("detects explicit demo-only/TODO blockers conservatively", () => {
    expect(
      detectAcceptancePlaceholders([
        {
          path: "client/src/App.vue",
          content: "当前为本地演示数据\n后续将接入真实 API\n// TODO: implement real authentication",
        },
      ]),
    ).toHaveLength(3);
    expect(
      detectAcceptancePlaceholders([
        {
          path: "src/a.ts",
          content:
            "const sample = 'sample'; // mock response\n// TODO: improve spacing\nconst example = 42;",
        },
      ]),
    ).toEqual([]);
  });
  it("validates fixed Windows command lines and rejects tampering", () => {
    const command = planProjectAcceptance(complete).commands[0];
    expect(acceptanceSpawnSpec(command, "win32")).toEqual({
      file: "cmd.exe",
      args: ["/d", "/s", "/c", "npm --ignore-scripts run build"],
    });
    expect(acceptanceSpawnSpec(command, "linux")).toEqual({
      file: "npm",
      args: ["--ignore-scripts", "run", "build"],
    });
    expect(() =>
      acceptanceSpawnSpec({ ...command, args: ["run", "build", "&", "bad"] }, "win32"),
    ).toThrow("allowlisted");
  });
});

const nodeSummary =
  "# tests 2\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0";
const nodeFiles = (directory = "backend", test = "node --test", build?: string) => ({
  "client/package.json": JSON.stringify(complete.frontend!.packageJson),
  [`${directory}/package.json`]: JSON.stringify({
    scripts: { test, ...(build ? { build } : {}) },
    devDependencies: { typescript: "^5" },
  }),
  [`${directory}/src/app.js`]: "export const app = {};",
  [`${directory}/index.cjs`]: "module.exports = {};",
  [`${directory}/tests/app.test.js`]: "import { test } from 'node:test'; test('works', () => {});",
});
const nodeSuccess: AcceptanceExecutor = async (command, cwd, signal) =>
  command.id === "backend-test"
    ? {
        exitCode: 0,
        output: command.tool === "node" ? nodeSummary : "Tests 2 passed (2)",
        durationMs: 1,
      }
    : success(command, cwd, signal);

describe("Node backend acceptance (fixtures and injected executors only)", () => {
  it.each(["backend", "server"])(
    "checks bounded JS sources and real Node tests in %s",
    async (directory) => {
      const root = await fixture(nodeFiles(directory));
      const snapshot = await inspectAcceptanceProject(root);
      const commands = planProjectAcceptance(snapshot).commands.filter((c) =>
        c.id.startsWith("backend-"),
      );
      expect(commands.map((c) => [c.tool, c.args])).toEqual([
        ["node", ["--check", "index.cjs"]],
        ["node", ["--check", "src/app.js"]],
        ["node", ["--test"]],
      ]);
      expect(acceptanceSpawnSpec(commands[0], "win32")).toEqual({
        file: "node",
        args: ["--check", "index.cjs"],
      });
      expect(acceptanceSpawnSpec(commands[2], "win32")).toEqual({ file: "node", args: ["--test"] });
      const report = await runProjectAcceptance(root, { executor: nodeSuccess });
      expect(report.status).toBe("passed");
      expect(report.checks.filter((c) => c.id === "backend-syntax")).toHaveLength(1);
    },
  );
  it("enforces a shared syntax deadline and aggregates incomplete checks", async () => {
    const root = await fixture(nodeFiles());
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    let syntaxCalls = 0;
    try {
      const report = await runProjectAcceptance(root, {
        executor: async (command, cwd, signal) => {
          if (command.id === "backend-syntax") {
            syntaxCalls++;
            now.mockReturnValue(62000);
          }
          return nodeSuccess(command, cwd, signal);
        },
      });
      expect(syntaxCalls).toBe(1);
      expect(report.checks.filter((c) => c.id === "backend-syntax")).toHaveLength(1);
      expect(report.checks.find((c) => c.id === "backend-syntax")?.status).toBe("blocked");
    } finally {
      now.mockRestore();
    }
  });
  it("blocks syntax scans beyond the bound and unsupported TS without a build", async () => {
    const files = nodeFiles();
    for (let i = 0; i < 128; i++) files[`backend/src/file${i}.js`] = "const a = 1;";
    const report = await runProjectAcceptance(await fixture(files), { executor: nodeSuccess });
    expect(report.checks.find((c) => c.id === "backend-syntax")?.status).toBe("blocked");
    const tsReport = await runProjectAcceptance(
      await fixture({ ...nodeFiles(), "backend/src/app.ts": "const a: string = '';" }),
      { executor: nodeSuccess },
    );
    expect(tsReport.checks.find((c) => c.id === "backend-syntax")?.status).toBe("blocked");
  });
  it("supports declared tsc build and backend Vitest", async () => {
    const root = await fixture(nodeFiles("backend", "vitest run", "tsc --noEmit"));
    const plan = planProjectAcceptance(await inspectAcceptanceProject(root));
    expect(plan.commands.some((c) => c.id === "backend-build")).toBe(true);
    expect(plan.commands.some((c) => c.id === "backend-syntax")).toBe(false);
    expect((await runProjectAcceptance(root, { executor: nodeSuccess })).status).toBe("passed");
  });
  it.each([
    "echo passed",
    "node -e '0'",
    "node --test tests/x.js",
    "node --test && echo pass",
    "vitest --passWithNoTests",
  ])("blocks unsupported/no-op test %s", async (test) => {
    const report = await runProjectAcceptance(await fixture(nodeFiles("backend", test)), {
      executor: nodeSuccess,
    });
    expect(report.checks.find((c) => c.id === "backend-test")?.status).toBe("blocked");
    expect(isNodeTestScript(test)).toBe(false);
  });
  it("blocks missing test sources and zero backend source files", async () => {
    const files = nodeFiles();
    delete files["backend/tests/app.test.js"];
    delete files["backend/src/app.js"];
    delete files["backend/index.cjs"];
    const report = await runProjectAcceptance(await fixture(files), { executor: nodeSuccess });
    expect(report.checks.find((c) => c.id === "backend-test")?.status).toBe("blocked");
    expect(report.checks.find((c) => c.id === "backend-syntax")?.status).toBe("blocked");
  });
  it.each([
    [nodeSummary.replace("# fail 0", "# fail 1"), "failed"],
    [nodeSummary + "\nnot ok 3 - broken", "failed"],
    [nodeSummary.replace("# skipped 0", "# skipped 1"), "blocked"],
    [nodeSummary.replace("# cancelled 0", "# cancelled 1"), "blocked"],
    [nodeSummary.replace("# pass 2", "# pass 0"), "blocked"],
    ["tests exited successfully", "blocked"],
    [nodeSummary.replace("# tests 2", "# tests 0"), "blocked"],
  ])("rejects misleading Node exit-zero output %s", async (output, status) => {
    const report = await runProjectAcceptance(await fixture(nodeFiles()), {
      executor: async (command, cwd, signal) =>
        command.id === "backend-test"
          ? { exitCode: 0, output, durationMs: 1 }
          : nodeSuccess(command, cwd, signal),
    });
    expect(report.checks.find((c) => c.id === "backend-test")?.status).toBe(status);
  });
  it("rejects failed/skipped Vitest summaries even with exit zero", async () => {
    for (const [output, status] of [
      ["Tests 1 failed | 2 passed", "failed"],
      ["Tests 2 passed | 1 skipped", "blocked"],
    ]) {
      const report = await runProjectAcceptance(await fixture(nodeFiles("backend", "vitest run")), {
        executor: async (command, cwd, signal) =>
          command.id === "backend-test"
            ? { exitCode: 0, output, durationMs: 1 }
            : nodeSuccess(command, cwd, signal),
      });
      expect(report.checks.find((c) => c.id === "backend-test")?.status).toBe(status);
    }
  });
  it("rejects Node argument injection, traversal and unsupported syntax paths", async () => {
    const command = planProjectAcceptance(
      await inspectAcceptanceProject(await fixture(nodeFiles())),
    ).commands.find((c) => c.id === "backend-syntax")!;
    for (const file of [
      "../evil.js",
      "/evil.js",
      "C:/evil.js",
      "a;evil.js",
      "--eval.js",
      "src/../../evil.js",
    ])
      expect(() => acceptanceSpawnSpec({ ...command, args: ["--check", file] }, "win32")).toThrow(
        "allowlisted",
      );
  });
});

describe("targeted acceptance", () => {
  it("runs only the selected declared frontend suite and excludes unrelated blockers", async () => {
    const executor = vi.fn(success);
    const root = await fixture({
      "client/package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "client/src/App.vue": "当前为本地演示数据",
    });
    const onlyCheckIds = ["frontend-test"] as const;
    const report = await runProjectAcceptance(root, { onlyCheckIds, executor });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0][0]).toMatchObject({
      id: "frontend-test",
      args: ["--ignore-scripts", "run", "test", "--", "--run"],
    });
    expect(report.checks.map((check) => check.id)).toEqual(["frontend-test"]);
    expect(report.status).toBe("passed");
    expect(report.limitations.join(" ")).toContain("不代表完整工程验收通过");
    expect((await runProjectAcceptance(root, { executor })).status).toBe("blocked");
  });
  it.each(["backend-test", "backend-syntax"])("executes only selected %s commands", async (id) => {
    const executor = vi.fn(nodeSuccess);
    const report = await runProjectAcceptance(await fixture(nodeFiles()), {
      onlyCheckIds: [id],
      executor,
    });
    expect(executor).toHaveBeenCalledTimes(id === "backend-syntax" ? 2 : 1);
    expect(executor.mock.calls.every(([command]) => command.id === id)).toBe(true);
    expect(report.checks.map((check) => check.id)).toEqual([id]);
    expect(report.status).toBe("passed");
  });
  it.each(["frontend-build", "backend-verify"])("executes only selected %s", async (id) => {
    const executor = vi.fn(success);
    const report = await runProjectAcceptance(await fixture(fullFiles), {
      onlyCheckIds: [id],
      executor,
    });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0][0].id).toBe(id);
    expect(report.checks.map((check) => check.id)).toEqual([id]);
    expect(report.status).toBe("passed");
  });
  it("returns selected placeholder and backend test-source checks without executing commands", async () => {
    const executor = vi.fn(success);
    const report = await runProjectAcceptance(await fixture(fullFiles), {
      onlyCheckIds: ["implementation-placeholders", "backend-tests"],
      executor,
    });
    expect(executor).not.toHaveBeenCalled();
    expect(report.checks.map((check) => check.id).sort()).toEqual([
      "backend-tests",
      "implementation-placeholders",
    ]);
    expect(report.status).toBe("passed");
  });
  it("preserves selected missing-script/source and inspection preconditions before execution", async () => {
    const executor = vi.fn(success);
    const missingScript = await runProjectAcceptance(
      await fixture({
        "client/package.json": JSON.stringify({ scripts: { build: "vite build" } }),
      }),
      { onlyCheckIds: ["frontend-test"], executor },
    );
    expect(missingScript.checks).toEqual([
      expect.objectContaining({
        id: "frontend-test",
        status: "blocked",
        output: expect.stringContaining("未声明"),
      }),
    ]);
    const files = { ...fullFiles };
    delete (files as Record<string, string>)["server/src/test/java/AppTest.java"];
    const missingTests = await runProjectAcceptance(await fixture(files), {
      onlyCheckIds: ["backend-verify"],
      executor,
    });
    expect(missingTests.checks).toEqual([
      expect.objectContaining({
        id: "backend-verify",
        status: "blocked",
        output: expect.stringContaining("未找到测试源码"),
      }),
    ]);
    const badInspection = await runProjectAcceptance(
      await fixture({
        ...fullFiles,
        "backend/package.json": "{broken",
      }),
      { onlyCheckIds: ["frontend-test"], executor },
    );
    expect(badInspection.checks).toEqual([
      expect.objectContaining({
        id: "frontend-test",
        status: "blocked",
        output: expect.stringContaining("Invalid backend/package.json"),
      }),
    ]);
    expect(executor).not.toHaveBeenCalled();
  });
  it("blocks unavailable/unknown and empty selections without executing other commands", async () => {
    const executor = vi.fn(success);
    const root = await fixture(fullFiles);
    for (const onlyCheckIds of [[], ["backend-test"], ["unknown-check"]]) {
      const report = await runProjectAcceptance(root, { onlyCheckIds, executor });
      expect(report.status).toBe("blocked");
      expect(report.checks.map((check) => check.id)).toEqual(onlyCheckIds);
    }
    expect(executor).not.toHaveBeenCalled();
  });
});

describe("bounded failure evidence", () => {
  it("preserves head, tail, marker and Node failure summaries in capped reports", async () => {
    const output = `STARTUP-CONTEXT\n${"verbose logs\n".repeat(3000)}Error: final-node-failure\n${nodeSummary.replace("# fail 0", "# fail 1")}`;
    const report = await runProjectAcceptance(await fixture(nodeFiles()), {
      onlyCheckIds: ["backend-test"],
      executor: async () => ({ exitCode: 0, output, durationMs: 1 }),
    });
    expect(report.status).toBe("failed");
    expect(report.checks[0].output).toContain("STARTUP-CONTEXT");
    expect(report.checks[0].output).toContain("[输出已截断]");
    expect(report.checks[0].output).toContain("Error: final-node-failure");
    expect(report.checks[0].output).toContain("# fail 1");
    expect(report.checks[0].output.length).toBeLessThanOrEqual(ACCEPTANCE_OUTPUT_LIMIT);
  });
  it("retains actual Node errors after long process logs within the process output cap", async () => {
    const root = await fixture({
      "test/failure.test.cjs":
        "const { test } = require('node:test'); test('failure', () => { console.log('STARTUP-CONTEXT'); console.log('x'.repeat(40000)); throw new Error('final-node-failure'); });",
    });
    const result = await executeAcceptanceCommand(
      {
        id: "backend-test",
        label: "Node fixture",
        directory: "backend",
        tool: "node",
        args: ["--test"],
        timeoutMs: 10_000,
      },
      root,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.blockedReason).toBeUndefined();
    expect(result.output).toContain("STARTUP-CONTEXT");
    expect(result.output).toContain("[输出已截断]");
    expect(result.output).toContain("final-node-failure");
    expect(result.output.length).toBeLessThanOrEqual(ACCEPTANCE_OUTPUT_LIMIT);
  });
});

describe("project acceptance with temporary fixtures and injected executor", () => {
  it("reports engineering success with explicit product limitations, never running real project builds", async () => {
    const calls: string[] = [];
    const root = await fixture(fullFiles);
    const report = await runProjectAcceptance(root, {
      executor: async (command, cwd) => {
        calls.push(`${command.id}:${path.relative(root, cwd)}`);
        return success(command, cwd);
      },
    });
    expect(report.version).toBe(1);
    expect(report.status).toBe("passed");
    expect(calls).toEqual([
      "frontend-build:client",
      "frontend-test:client",
      "backend-verify:server",
    ]);
    expect(report.limitations.join(" ")).toMatch(/工程检查.*交付/);
    expect(report.limitations.join(" ")).toMatch(/API.*数据库/);
    expect(report.limitations.join(" ")).toMatch(/用户路径.*推荐.*端到端.*人工/);
  });
  it("chooses client before root and can fall back to root package.json", async () => {
    const root = await fixture({
      ...fullFiles,
      "package.json": JSON.stringify({ scripts: { build: "wrong", test: "jest" } }),
    });
    expect((await inspectAcceptanceProject(root)).frontend?.directory).toBe("client");
    await fs.rm(path.join(root, "client"), { recursive: true });
    expect((await inspectAcceptanceProject(root)).frontend?.directory).toBe(".");
  });
  it("blocks empty projects and invalid manifests", async () => {
    expect((await runProjectAcceptance(await fixture(), { executor: success })).status).toBe(
      "blocked",
    );
    const report = await runProjectAcceptance(await fixture({ "package.json": "{broken" }), {
      executor: success,
    });
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "inspection",
        status: "blocked",
        output: expect.stringContaining("Invalid package.json"),
      }),
    );
  });
  it("blocks explicit demo-only frontend even when build/test exit zero", async () => {
    const root = await fixture({ ...fullFiles, "client/src/App.vue": "当前为本地演示数据" });
    const report = await runProjectAcceptance(root, { executor: success });
    expect(report.status).toBe("blocked");
    expect(report.checks.find((c) => c.id === "implementation-placeholders")?.output).toContain(
      "client/src/App.vue:1",
    );
  });
  it("preserves failed builds and caps executor output", async () => {
    const root = await fixture(fullFiles);
    const report = await runProjectAcceptance(root, {
      executor: async (command) => ({
        exitCode: command.id === "frontend-build" ? 1 : 0,
        output: "x".repeat(50_000),
        durationMs: 3,
      }),
    });
    expect(report.status).toBe("failed");
    expect(report.checks.find((c) => c.id === "frontend-build")?.status).toBe("failed");
    expect(report.checks.every((c) => c.output.length <= 16_000)).toBe(true);
  });
  it.each([
    ["frontend-test", "Tests  1 failed | 2 passed (3)"],
    ["frontend-test", "Test Files  1 failed | 1 passed (2)\nTests  2 passed (2)"],
    ["backend-verify", "Tests run: 3, Failures: 1, Errors: 0, Skipped: 0"],
    ["backend-verify", "Tests run: 3, Failures: 0, Errors: 1, Skipped: 0"],
  ])("fails %s when test summary contains failures despite exit zero", async (id, output) => {
    const root = await fixture(fullFiles);
    const report = await runProjectAcceptance(root, {
      executor: async (command, cwd, signal) =>
        command.id === id ? { exitCode: 0, output, durationMs: 1 } : success(command, cwd, signal),
    });
    expect(report.status).toBe("failed");
    expect(report.checks.find((check) => check.id === id)?.status).toBe("failed");
  });
  it("blocks exit-zero tests without evidence of actual test execution", async () => {
    const report = await runProjectAcceptance(await fixture(fullFiles), {
      executor: async () => ({
        exitCode: 0,
        output: "Tests run: 2, Failures: 0, Errors: 0, Skipped: 2",
        durationMs: 1,
      }),
    });
    expect(report.checks.find((check) => check.id === "frontend-test")?.status).toBe("blocked");
    expect(report.checks.find((check) => check.id === "backend-verify")?.status).toBe("blocked");
  });
  it("reports missing tools/timeouts/executor errors as blocked", async () => {
    const root = await fixture(fullFiles);
    for (const reason of ["Required tool mvn is unavailable.", "Command exceeded 100ms timeout."]) {
      const report = await runProjectAcceptance(root, {
        executor: async () => ({
          exitCode: null,
          output: reason,
          durationMs: 10,
          blockedReason: reason,
        }),
      });
      expect(report.status).toBe("blocked");
    }
    expect(
      (
        await runProjectAcceptance(root, {
          executor: async () => {
            throw new Error("unavailable");
          },
        })
      ).status,
    ).toBe("blocked");
  });
  it("honors already-aborted signals without spawning or calling injected commands", async () => {
    const controller = new AbortController();
    controller.abort();
    const command = planProjectAcceptance(complete).commands[0];
    expect((await executeAcceptanceCommand(command, ".", controller.signal)).blockedReason).toMatch(
      /取消/,
    );
    let calls = 0;
    const report = await runProjectAcceptance(await fixture(fullFiles), {
      signal: controller.signal,
      executor: async (...args) => {
        calls++;
        return success(...args);
      },
    });
    expect(calls).toBe(0);
    expect(report.status).toBe("blocked");
  });
  it("does not scan ignored generated/dependency directories", async () => {
    const root = await fixture({
      ...fullFiles,
      "client/node_modules/pkg/demo.js": "当前为本地演示数据",
      "server/target/Fixture.java": "TODO: implement real API",
    });
    expect((await runProjectAcceptance(root, { executor: success })).status).toBe("passed");
  });
});
