import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dependencyDocker, withDependencyNetwork } from "@/server/agents/codex-dependency-network";
import { prepareCodexDependencies } from "@/server/agents/codex-dependencies";

/**
 * Opt-in real-Docker verification of the controlled dependency download boundary.
 * PowerShell:
 *   $env:CODEX_DEPENDENCY_INTEGRATION='1'; pnpm exec vitest run tests/integration/codex-dependency-network.integration.test.ts --reporter=verbose
 *
 * No model call. The fixture has no lockfile, so this proves that a missing
 * lockfile is generated inside the disposable copy and that registry access
 * works only through the restricted proxy.
 */
const integration = process.env.CODEX_DEPENDENCY_INTEGRATION === "1" ? describe : describe.skip;

integration("controlled dependency download boundary (real Docker, no model)", () => {
  it("generates a missing lockfile and installs a real Node package through the proxy", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gs-dep-net-"));
    const copy = path.join(root, "client");
    await fs.mkdir(copy, { recursive: true });
    await fs.writeFile(
      path.join(copy, "package.json"),
      JSON.stringify({
        name: "fixture-client",
        version: "1.0.0",
        private: true,
        dependencies: { "is-number": "7.0.0" },
      }),
    );
    try {
      const report = await prepareCodexDependencies(root, AbortSignal.timeout(600_000));
      expect(report.isolation).toBe("docker-internal-network-controlled-proxy");
      expect(report.status).toBe("passed");
      expect(report.lockfileGenerated).toBe(true);
      await expect(fs.stat(path.join(copy, "node_modules", "is-number"))).resolves.toBeTruthy();
      // The generated lockfile stays inside the disposable copy.
      await expect(fs.stat(path.join(copy, "package-lock.generated.json"))).resolves.toBeTruthy();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 900_000);

  it("leaves no dependency network or proxy container behind", async () => {
    await withDependencyNetwork(async ({ networkName, proxyUrl }) => {
      expect(proxyUrl).toMatch(/^http:\/\/gs-codex-deps-proxy-/);
      // A plaintext request is refused by the proxy; only registry CONNECT is allowed.
      const probe = await dependencyDocker(
        [
          "run",
          "--rm",
          "--pull",
          "never",
          "--network",
          networkName,
          "--entrypoint",
          "node",
          "gs-codex-worker:0.150.1",
          "-e",
          `fetch('${proxyUrl}/').then(r=>process.stdout.write('STATUS'+r.status)).catch(()=>process.stdout.write('REFUSED'))`,
        ],
        AbortSignal.timeout(60_000),
      );
      expect(probe).toContain("STATUS403");
    });
    const networks = await dependencyDocker([
      "network",
      "ls",
      "--filter",
      "name=gs-codex-deps-",
      "--format",
      "{{.Name}}",
    ]);
    const containers = await dependencyDocker([
      "ps",
      "--all",
      "--filter",
      "name=gs-codex-deps-",
      "--format",
      "{{.Names}}",
    ]);
    expect(networks.trim()).toBe("");
    expect(containers.trim()).toBe("");
  }, 300_000);
});
