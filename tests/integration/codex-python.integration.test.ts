import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyCodexPythonBackend } from "@/server/agents/codex-python-verification";

/**
 * Opt-in real-Docker verification of isolated Python backend checks.
 * PowerShell:
 *   $env:CODEX_PYTHON_INTEGRATION='1'; pnpm exec vitest run tests/integration/codex-python.integration.test.ts --reporter=verbose
 *
 * No model call and no host execution: wheels are downloaded through the
 * restricted proxy, then installed and executed fully offline.
 */
const integration = process.env.CODEX_PYTHON_INTEGRATION === "1" ? describe : describe.skip;

async function fixture(passing: boolean) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gs-py-"));
  const server = path.join(root, "server");
  await fs.mkdir(path.join(server, "app"), { recursive: true });
  await fs.mkdir(path.join(server, "tests"), { recursive: true });
  await fs.writeFile(path.join(server, "requirements.txt"), "six==1.16.0\n");
  await fs.writeFile(path.join(server, "app", "__init__.py"), "");
  await fs.writeFile(
    path.join(server, "app", "main.py"),
    "import six\n\n\ndef value():\n    return six.__version__\n",
  );
  await fs.writeFile(
    path.join(server, "tests", "test_main.py"),
    passing
      ? "from app.main import value\n\n\ndef test_value():\n    assert isinstance(value(), str)\n"
      : "from app.main import value\n\n\ndef test_value():\n    assert value() == 'definitely-wrong'\n",
  );
  return root;
}

integration("isolated Python backend verification (real Docker, no model)", () => {
  it("installs wheels offline and reports a passing pytest run", async () => {
    const root = await fixture(true);
    try {
      const result = await verifyCodexPythonBackend(root, AbortSignal.timeout(900_000));
      const names = result.checks.map((check) => `${check.name}:${check.status}`);
      expect(names).toContain("server:python:dependencies:passed");
      expect(names).toContain("server:python:tests:passed");
      expect(result.status).toBe("passed");
      const tests = result.checks.find((check) => check.name === "server:python:tests")!;
      expect(tests.command).toContain("-m pytest");
      expect(tests.durationMs).toBeGreaterThan(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 1_200_000);

  it("reports a real failing test as failed, never as success", async () => {
    const root = await fixture(false);
    try {
      const result = await verifyCodexPythonBackend(root, AbortSignal.timeout(900_000));
      expect(result.status).toBe("failed");
      expect(result.checks.map((check) => check.name)).toContain("server:python:tests");
      const tests = result.checks.find((check) => check.name === "server:python:tests")!;
      expect(tests.output).toContain("test_main::test_value");
      expect(tests.command).toContain("-m pytest");
      expect(tests.durationMs).toBeGreaterThan(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 1_200_000);
});
