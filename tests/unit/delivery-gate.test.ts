import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runDeliveryGate,
  decideGateStatus,
  finalizeChecks,
  gateNeedsRepair,
  mavenTestSummary,
  nodeTestEvidence,
  parseSteps,
  expectedRuntimeChecks,
  composeOverride,
  auditComposeConfig,
  redactKnownSecrets,
  formatGateEvidence,
  type DockerRunner,
  type DockerOutcome,
} from "@/server/agents/delivery-gate";
import { deliveryContractSchema } from "@/server/agents/delivery-contract";

const dirs: string[] = [];
async function project(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(tmpdir(), "gs-gate-test-"));
  dirs.push(dir);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
  }
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const ok = (output = ""): DockerOutcome => ({
  code: 0,
  output,
  timedOut: false,
  spawnError: false,
});
const NODE_OK =
  "added 10 packages\nGS_STEP install 0\nvite build done\nGS_STEP build 0\n Tests  3 passed (3)\nGS_STEP test 0\n";
const MAVEN_OK =
  "[INFO] Results:\n[INFO] Tests run: 6, Failures: 0, Errors: 0, Skipped: 0\n[INFO] BUILD SUCCESS\nGS_STEP maven 0\n";
const MAVEN_COMPILE_ERROR =
  "[ERROR] COMPILATION ERROR :\n[ERROR] /w/src/main/java/com/x/OrderService.java:[42,17] cannot find symbol\nGS_STEP maven 1\n";

/** 记录调用并按镜像/子命令返回脚本化结果的假 docker。 */
function fakeDocker(script: {
  node?: string;
  maven?: string;
  compose?: Partial<Record<string, DockerOutcome>>;
}) {
  const calls: string[][] = [];
  const runner: DockerRunner = async (args) => {
    calls.push(args);
    if (args[0] === "volume") return ok();
    if (args[0] === "run" && args.includes("node:22-bookworm")) return ok(script.node ?? NODE_OK);
    if (args[0] === "run" && args.some((a) => a.startsWith("maven:")))
      return ok(script.maven ?? MAVEN_OK);
    if (args[0] === "compose") {
      const sub =
        args.find((a) => ["config", "up", "ps", "logs", "down", "restart"].includes(a)) ?? "";
      return script.compose?.[sub] ?? ok(sub === "config" ? "mysql\nbackend\nfrontend\n" : "");
    }
    return ok();
  };
  return { runner, calls };
}

const SPRING_VUE = {
  "client/package.json": JSON.stringify({ scripts: { build: "vite build", test: "vitest run" } }),
  "server/pom.xml": "<project><artifactId>spring-boot</artifactId></project>",
  "server/src/main/java/App.java": "class App {}",
};

describe("delivery gate: absence is never success", () => {
  it("fails the 10-17 shape: frontend passes but the Spring Boot backend does not compile", async () => {
    const { runner } = fakeDocker({ maven: MAVEN_COMPILE_ERROR });
    const result = await runDeliveryGate(await project(SPRING_VUE), {
      docker: runner,
      tier: "fast",
    });
    expect(result.checks.find((c) => c.name === "client:build")?.status).toBe("passed");
    const backend = result.checks.find((c) => c.name === "server:maven:test");
    expect(backend?.status).toBe("failed");
    expect(backend?.cause).toBe("code");
    expect(backend?.output).toContain("cannot find symbol");
    expect(result.status).toBe("failed");
    expect(gateNeedsRepair(result)).toBe(true);
  });

  it("passes only when every expected stack check ran and passed", async () => {
    const { runner } = fakeDocker({});
    const result = await runDeliveryGate(await project(SPRING_VUE), {
      docker: runner,
      tier: "fast",
    });
    expect(result.checks.map((c) => `${c.name}:${c.status}`).sort()).toEqual([
      "client:build:passed",
      "client:test:passed",
      "server:maven:test:passed",
    ]);
    expect(result.status).toBe("passed");
  });

  it("blocks a backend that compiles but executes zero tests", async () => {
    const { runner } = fakeDocker({
      maven: "[INFO] No tests to run.\n[INFO] BUILD SUCCESS\nGS_STEP maven 0\n",
    });
    const result = await runDeliveryGate(await project(SPRING_VUE), {
      docker: runner,
      tier: "fast",
    });
    const backend = result.checks.find((c) => c.name === "server:maven:test");
    expect(backend?.status).toBe("blocked");
    expect(backend?.cause).toBe("code");
    expect(result.status).toBe("blocked");
  });

  it("blocks unsupported stacks as an environment problem instead of hiding them", async () => {
    const { runner } = fakeDocker({});
    const result = await runDeliveryGate(
      await project({ ...SPRING_VUE, "backend/build.gradle": "" }),
      { docker: runner, tier: "fast" },
    );
    const gradle = result.checks.find((c) => c.name === "stack:backend:gradle");
    expect(gradle?.status).toBe("blocked");
    expect(gradle?.cause).toBe("environment");
    expect(result.status).toBe("blocked");
    expect(gateNeedsRepair(result)).toBe(false);
  });

  it("blocks missing build/test scripts as code problems the model can fix", async () => {
    const { runner } = fakeDocker({ node: "GS_STEP install 0\nbuilt\nGS_STEP build 0\n" });
    const result = await runDeliveryGate(
      await project({
        "client/package.json": JSON.stringify({ scripts: { build: "vite build" } }),
      }),
      { docker: runner, tier: "fast" },
    );
    expect(result.checks.find((c) => c.name === "client:test")).toMatchObject({
      status: "blocked",
      cause: "code",
    });
    expect(gateNeedsRepair(result)).toBe(true);
  });

  it("full tier requires compose and a delivery contract", async () => {
    const { runner } = fakeDocker({});
    const result = await runDeliveryGate(await project(SPRING_VUE), {
      docker: runner,
      tier: "full",
    });
    expect(result.checks.find((c) => c.name === "delivery:compose")?.status).toBe("blocked");
    expect(result.checks.find((c) => c.name === "delivery:contract")?.status).toBe("blocked");
    expect(result.status).toBe("blocked");
  });

  it("records every expected runtime check as blocked when compose up fails, and keeps repair possible", async () => {
    const contract = {
      version: 1,
      backend: { service: "backend", port: 8080, health: "/api/health" },
      accounts: [{ role: "admin", username: "admin", password: "x" }],
      smoke: [
        { kind: "http", as: "admin", method: "GET", path: "/api/auth/me", expectStatus: 200 },
      ],
    };
    const { runner, calls } = fakeDocker({
      compose: {
        up: { code: 1, output: "service backend is unhealthy", timedOut: false, spawnError: false },
      },
    });
    const result = await runDeliveryGate(
      await project({
        ...SPRING_VUE,
        "compose.yaml": "services: {}\n",
        "delivery/contract.json": JSON.stringify(contract),
      }),
      { docker: runner, tier: "auto" },
    );
    expect(result.tier).toBe("full");
    expect(result.checks.find((c) => c.name === "runtime:compose-up")?.status).toBe("failed");
    const missing = result.checks.find((c) => c.name === "smoke:skeleton:0");
    expect(missing).toMatchObject({ status: "blocked", cause: "code" });
    expect(result.status).toBe("failed");
    expect(gateNeedsRepair(result)).toBe(true);
    // 闸门实例总会被清理
    expect(calls.some((a) => a[0] === "compose" && a.includes("down"))).toBe(true);
  });

  it("does not start the system when the build is already broken", async () => {
    const { runner, calls } = fakeDocker({ maven: MAVEN_COMPILE_ERROR });
    const contract = {
      version: 1,
      backend: { service: "backend", port: 8080, health: "/api/health" },
    };
    await runDeliveryGate(
      await project({
        ...SPRING_VUE,
        "compose.yaml": "services: {}\n",
        "delivery/contract.json": JSON.stringify(contract),
      }),
      { docker: runner, tier: "full" },
    );
    expect(calls.some((a) => a[0] === "compose" && a.includes("up"))).toBe(false);
  });

  it("bypasses a daemon HTTP proxy for internal page checks", async () => {
    const contract = {
      version: 1,
      backend: { service: "backend", port: 8080, health: "/api/health" },
      frontend: { service: "web", port: 80 },
      accounts: [{ role: "admin", username: "admin", password: "x" }],
      smoke: [],
    };
    const { runner, calls } = fakeDocker({});
    await runDeliveryGate(
      await project({
        ...SPRING_VUE,
        "compose.yaml": "services: {}\n",
        "delivery/contract.json": JSON.stringify(contract),
      }),
      {
        docker: runner,
        tier: "full",
        smoke: [{ moduleId: "m", smoke: [{ kind: "page", as: "admin", route: "/x", expectText: ["X"] }] }],
      },
    );
    const page = calls.find(
      (a) => a[0] === "run" && a.some((v) => v.startsWith("NO_PROXY=")),
    );
    expect(page).toBeDefined();
    // Chromium 读代理设置，内网服务名必须绕过代理，否则会拿到 502。
    expect(page).toContain("NO_PROXY=localhost,127.0.0.1,backend,web");
    expect(page).toContain("no_proxy=localhost,127.0.0.1,backend,web");
  });

  it("refuses to start a compose that reaches for the host, and never runs up", async () => {
    const { runner, calls } = fakeDocker({
      compose: {
        config: {
          code: 0,
          output: [
            "services:",
            "  backend:",
            "    privileged: true",
            "    volumes:",
            "      - type: bind",
            "        source: /var/run/docker.sock",
            "        target: /var/run/docker.sock",
          ].join("\n"),
          timedOut: false,
          spawnError: false,
        },
      },
    });
    const contract = {
      version: 1,
      backend: { service: "backend", port: 8080, health: "/api/health" },
    };
    const result = await runDeliveryGate(
      await project({
        ...SPRING_VUE,
        "compose.yaml": "services:\n  backend:\n    privileged: true\n",
        "delivery/contract.json": JSON.stringify(contract),
      }),
      { docker: runner, tier: "full" },
    );
    const up = result.checks.find((c) => c.name === "runtime:compose-up");
    expect(up?.status).toBe("failed");
    expect(up?.cause).toBe("code");
    expect(up?.output).toContain("docker.sock");
    expect(up?.output).toContain("privileged");
    expect(calls.some((a) => a[0] === "compose" && a.includes("up"))).toBe(false);
  });

  it("runs every build container without privilege escalation", async () => {
    const { runner, calls } = fakeDocker({});
    await runDeliveryGate(await project(SPRING_VUE), { docker: runner, tier: "fast" });
    const runs = calls.filter((a) => a[0] === "run");
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run).toContain("--rm");
      expect(run).toContain("no-new-privileges:true");
    }
  });

  it("never mutates the stage (works on a copy)", async () => {
    const dir = await project(SPRING_VUE);
    const { runner, calls } = fakeDocker({});
    await runDeliveryGate(dir, { docker: runner, tier: "fast" });
    const mounts = calls.flatMap((a) => a.filter((x) => x.endsWith(":/w")));
    expect(mounts.length).toBeGreaterThan(0);
    for (const mount of mounts) expect(mount.startsWith(dir)).toBe(false);
  });
});

describe("delivery gate helpers", () => {
  it("decides status strictly", () => {
    expect(decideGateStatus([])).toBe("blocked");
    expect(decideGateStatus([{ name: "a", status: "passed", output: "" }])).toBe("passed");
    expect(
      decideGateStatus([
        { name: "a", status: "passed", output: "" },
        { name: "b", status: "not_run", output: "" },
      ]),
    ).toBe("blocked");
    expect(
      decideGateStatus(finalizeChecks([{ name: "a", status: "passed", output: "" }], ["a", "b"])),
    ).toBe("blocked");
  });
  it("parses tool output", () => {
    expect(
      mavenTestSummary(
        "Tests run: 2, Failures: 0, Errors: 0, Skipped: 0 - in com.x.ATest\nTests run: 6, Failures: 1, Errors: 0, Skipped: 1\n",
      ),
    ).toEqual({ run: 6, failed: 1, skipped: 1 });
    expect(nodeTestEvidence(" Tests  3 passed (3)")).toBe(true);
    expect(nodeTestEvidence("No test files found, exiting with code 0")).toBe(false);
    expect(parseSteps("a\nGS_STEP install 0\nb\nGS_STEP build 2\n").get("build")).toEqual({
      code: 2,
      output: "b\n",
    });
  });
  it("computes expected runtime checks including persistence and pages", () => {
    const contract = deliveryContractSchema.parse({
      version: 1,
      backend: { service: "backend", port: 8080, health: "/api/health" },
      frontend: { service: "frontend", port: 80 },
      accounts: [{ role: "admin", username: "a", password: "b" }],
    });
    const names = expectedRuntimeChecks(contract, [
      {
        moduleId: "m",
        smoke: [
          {
            kind: "http",
            as: "admin",
            method: "POST",
            path: "/api/x",
            expectStatus: 200,
            saveAs: { id: "data.id" },
          },
          { kind: "http", as: "admin", method: "GET", path: "/api/x/{{id}}", expectStatus: 200 },
          { kind: "page", as: "admin", route: "/x", expectText: ["X"] },
        ],
      },
    ]);
    expect(names).toEqual(
      expect.arrayContaining([
        "runtime:compose-up",
        "runtime:health:frontend",
        "smoke:m:0",
        "smoke:m:1",
        "persist:m:1",
        "page:m:2",
        "persist:restart",
      ]),
    );
  });
  it("strips host ports in the gate override", () => {
    expect(composeOverride(["backend"])).toContain("ports: !reset []");
  });
  it("redacts only real secret values and keeps evidence long enough to debug", () => {
    expect(redactKnownSecrets("key=abcdefgh12345 ok", { DEEPSEEK_API_KEY: "abcdefgh12345" })).toBe(
      "key=[已隐藏:DEEPSEEK_API_KEY] ok",
    );
    const evidence = formatGateEvidence({
      version: 1,
      status: "failed",
      tier: "fast",
      screenshots: [],
      startedAt: "",
      finishedAt: "",
      checks: [
        { name: "server:maven:test", status: "failed", output: "x".repeat(5000) + "ROOT CAUSE" },
      ],
    });
    expect(evidence).toContain("ROOT CAUSE");
  });
});

describe("delivery gate: a generated compose cannot reach the host", () => {
  const wrap = (body: string) => `services:\n  backend:\n    image: node:22\n${body}\n`;

  it("allows an ordinary project compose: in-workspace binds, named volumes, build context", async () => {
    const root = await project({ "server/Dockerfile": "FROM node:22\n" });
    const config = [
      "name: demo",
      "services:",
      "  backend:",
      "    build:",
      `      context: ${path.join(root, "server")}`,
      "      dockerfile: Dockerfile",
      "    volumes:",
      "      - type: bind",
      `        source: ${path.join(root, "server", "init.sql")}`,
      "        target: /docker-entrypoint-initdb.d/init.sql",
      "      - type: volume",
      "        source: dbdata",
      "        target: /var/lib/mysql",
      "  db:",
      "    image: mysql:8",
      "volumes:",
      "  dbdata: {}",
    ].join("\n");
    expect(auditComposeConfig(config, root)).toEqual([]);
    // build.context 常常就是副本根目录本身（等值，不是子目录）。
    expect(auditComposeConfig(config.replace(path.join(root, "server"), root), root)).toEqual([]);
  });

  it.each([
    ["privileged: true", "privileged"],
    ["cap_add:\n      - SYS_ADMIN", "cap_add"],
    ["devices:\n      - /dev/sda", "devices"],
    ["network_mode: host", "network_mode: host"],
    ["pid: host", "pid: host"],
    ["ipc: host", "ipc: host"],
    ["cgroup_parent: /docker", "cgroup_parent"],
    ["security_opt:\n      - seccomp=unconfined", "seccomp=unconfined"],
    ["volumes:\n      - /var/run/docker.sock:/var/run/docker.sock", "docker.sock"],
    [
      "volumes:\n      - type: bind\n        source: /etc/passwd\n        target: /host/passwd",
      "宿主敏感路径",
    ],
    ["volumes:\n      - /opt/elsewhere:/data", "工作区副本之外"],
  ])("rejects %s", async (body, expected) => {
    const root = await project({});
    expect(auditComposeConfig(wrap(`    ${body}`), root).join("\n")).toContain(expected);
  });

  it("rejects a named volume whose driver_opts bind a host device", async () => {
    const root = await project({});
    const config = [
      "services:",
      "  backend:",
      "    volumes:",
      "      - type: volume",
      "        source: sock",
      "        target: /sock",
      "volumes:",
      "  sock:",
      "    driver: local",
      "    driver_opts:",
      "      type: none",
      "      device: /var/run/docker.sock",
      "      o: bind",
    ].join("\n");
    expect(auditComposeConfig(config, root).join("\n")).toContain("docker.sock");
  });

  it("hardens the override without breaking images that must chown their data dir", () => {
    const override = composeOverride(["db"]);
    expect(override).toContain("no-new-privileges:true");
    expect(override).not.toContain("cap_drop");
  });
});
