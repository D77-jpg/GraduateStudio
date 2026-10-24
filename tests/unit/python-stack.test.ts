import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("../../src/server/agents/codex-dependency-network", () => ({
  dependencyDocker: vi.fn(),
  withDependencyNetwork: vi.fn(),
}));
vi.mock("../../src/server/runtime/python-model-relay", () => ({
  ensurePythonModelRelay: vi.fn(),
  stopPythonModelRelay: vi.fn(),
}));
import {
  dependencyDocker,
  withDependencyNetwork,
} from "../../src/server/agents/codex-dependency-network";
import {
  pythonStackIdentity,
  assertPythonResourceLabels,
  detectPythonStack,
  ensurePythonRuntimeSecrets,
  pythonRequirementsHash,
  snapshotPythonSource,
  startPythonStack,
  stopPythonStack,
} from "../../src/server/runtime/python-stack";

let root: string;
const docker = vi.mocked(dependencyDocker);
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gs-python-test-"));
  docker.mockReset();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true });
});
const owner = "io.graduatestudio.python-runtime";
const labels = (project: string, role: string) => ({
  [owner]: "1",
  [`${owner}.project`]: pythonStackIdentity(project).key,
  [`${owner}.role`]: role,
});
async function backend() {
  const server = path.join(root, "server");
  await fs.mkdir(path.join(server, "app"), { recursive: true });
  await fs.writeFile(path.join(server, "requirements.txt"), "fastapi==0.115.0\n");
  await fs.writeFile(path.join(server, "app/main.py"), "# Not executed by unit tests\n");
  return server;
}

async function runtimeFixture(egress?: {
  Internal: unknown;
  Driver?: string;
  Labels?: Record<string, string>;
}) {
  await backend();
  vi.spyOn(process, "cwd").mockReturnValue(root);
  const projectId = "runtime-network-test";
  const id = pythonStackIdentity(projectId);
  const image = `sha256:${"a".repeat(64)}`;
  const containers = new Map<string, Record<string, unknown>>();
  const networks = new Map<string, Record<string, unknown>>();
  if (egress)
    networks.set(id.egressNetwork, {
      Labels: labels(projectId, "egress-network"),
      Driver: "bridge",
      ...egress,
    });
  docker.mockImplementation(async (args) => {
    if (args[0] === "ps") {
      const filter = args.find((arg) => arg.startsWith("name=^/"));
      const name = filter?.slice(7, -1);
      return name && containers.has(name) ? name : "";
    }
    if (args[0] === "image")
      return args[1] === "ls" ? image : JSON.stringify([{ Id: image, Os: "linux" }]);
    if (args[0] === "volume") return args[1] === "ls" ? "" : "volume";
    if (args[0] === "network") {
      const name = args.at(-1)!;
      if (args[1] === "ls") {
        const filter = args.find((arg) => arg.startsWith("name=^"));
        const requested = filter?.slice(6, -1);
        return requested && networks.has(requested) ? requested : "";
      }
      if (args[1] === "inspect") return JSON.stringify([networks.get(name)]);
      if (args[1] === "create") {
        networks.set(name, {
          Labels: labels(projectId, name === id.network ? "network" : "egress-network"),
          Internal: args.includes("--internal"),
          Driver: "bridge",
        });
        return name;
      }
      if (args[1] === "connect") return "";
    }
    if (args[0] === "create") {
      const name = args[args.indexOf("--name") + 1];
      const role = name.slice(id.prefix.length + 1);
      containers.set(name, {
        Id: name,
        Config: { Labels: labels(projectId, role) },
        State: { Running: true, ExitCode: 0 },
      });
      return name;
    }
    if (args[0] === "container" && args[1] === "inspect")
      return JSON.stringify([containers.get(args[2])]);
    if (args[0] === "start") return "";
    if (args[0] === "rm") {
      containers.delete(args.at(-1)!);
      return "";
    }
    throw new Error(`Unexpected mocked Docker command: ${args.join(" ")}`);
  });
  vi.mocked(withDependencyNetwork).mockImplementation(async (callback) =>
    callback({
      networkName: "dependency-only",
      proxyUrl: "http://dependency-proxy",
      imageId: image,
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: "ok",
            checks: [
              { name: "database", status: "ok" },
              { name: "cache", status: "ok" },
              { name: "queue", status: "ok", extra: { workers: ["worker"] } },
            ],
          }),
        ),
    ),
  );
  return { id, projectId, projectDir: root, port: 9000 };
}

describe("Python stack isolation helpers", () => {
  it("uses deterministic traversal-proof project namespaces", () => {
    expect(pythonStackIdentity("../a").prefix).toMatch(/^gs-python-[a-f0-9]{24}$/);
    expect(pythonStackIdentity("a").prefix).not.toBe(pythonStackIdentity("b").prefix);
    expect(pythonStackIdentity("a").prefix).toBe(pythonStackIdentity("a").prefix);
    expect(() => pythonStackIdentity("bad\nidentity")).toThrow();
  });
  it("requires version, project AND role labels", () => {
    expect(() => assertPythonResourceLabels(labels("a", "mysql"), "a", "mysql")).not.toThrow();
    for (const bad of [
      undefined,
      {},
      labels("b", "mysql"),
      labels("a", "redis"),
      { ...labels("a", "mysql"), [owner]: "2" },
    ])
      expect(() => assertPythonResourceLabels(bad, "a", "mysql")).toThrow(/identity mismatch/);
  });
  it("detects FastAPI without reading or executing .env or Dockerfiles", async () => {
    expect(detectPythonStack(root)).toBe(false);
    await backend();
    await fs.mkdir(path.join(root, "server/.env"));
    await fs.writeFile(path.join(root, "Dockerfile"), "UNTRUSTED");
    expect(detectPythonStack(root)).toBe(true);
    expect(docker).not.toHaveBeenCalled();
  });
  it("keys cache by requirements, image and fixed source", () => {
    expect(pythonRequirementsHash(["a", "b"], "image1")).toBe(
      pythonRequirementsHash(["b", "a"], "image1"),
    );
    expect(pythonRequirementsHash(["a"], "image1")).not.toBe(
      pythonRequirementsHash(["a"], "image2"),
    );
    expect(pythonRequirementsHash(["a"], "image1")).not.toBe(
      pythonRequirementsHash(["b"], "image1"),
    );
  });
  it("persists random credentials privately and reuses rather than rotates them", async () => {
    const state = path.join(root, "state");
    expect(await ensurePythonRuntimeSecrets(state, "a")).toBeUndefined();
    const original = await fs.readFile(path.join(state, "app.env"), "utf8");
    expect(original).toMatch(/^APP_ENV=development/m);
    expect(original).toMatch(/^INITIAL_ADMIN_PASSWORD=[a-f0-9]{48}$/m);
    expect(original).toMatch(/^SECRET_KEY=[a-f0-9]{64}$/m);
    await ensurePythonRuntimeSecrets(state, "a");
    expect(await fs.readFile(path.join(state, "app.env"), "utf8")).toBe(original);
    if (process.platform !== "win32")
      expect((await fs.stat(path.join(state, "app.env"))).mode & 0o777).toBe(0o600);
    await fs.rm(path.join(state, "mysql.env"));
    await expect(ensurePythonRuntimeSecrets(state, "a")).rejects.toThrow(/Incomplete/);
  });
  it("copies source only; excludes env, credentials, databases and writable state", async () => {
    const source = await backend();
    for (const name of [".env", ".env.example", "credentials.json", "private.pem", "data.db"])
      await fs.writeFile(path.join(source, name), "never copy me");
    await fs.mkdir(path.join(source, "var"));
    await fs.writeFile(path.join(source, "var/secret"), "never copy me");
    const target = path.join(root, "snapshot");
    await snapshotPythonSource(source, target);
    expect((await fs.readdir(target)).sort()).toEqual(["app", "requirements.txt"]);
    expect(await fs.readFile(path.join(target, "app/main.py"), "utf8")).toContain("Not executed");
  });
  it("rejects corrupt persisted credentials without reflecting their content", async () => {
    const state = path.join(root, "state");
    await ensurePythonRuntimeSecrets(state, "a");
    await fs.writeFile(path.join(state, "app.env"), "SECRET_KEY=DO_NOT_DISCLOSE\n");
    await expect(ensurePythonRuntimeSecrets(state, "a")).rejects.toThrow(
      "Invalid Python runtime credentials",
    );
    expect(await fs.readFile(path.join(state, "app.env"), "utf8")).toContain("DO_NOT_DISCLOSE");
  });
  it("cancellation before start causes no Docker actions and reveals no secrets", async () => {
    await backend();
    const controller = new AbortController();
    controller.abort(new Error("SECRET_CREDENTIAL"));
    const log = vi.fn();
    await expect(
      startPythonStack({
        projectId: "a",
        projectDir: root,
        port: 9000,
        signal: controller.signal,
        log,
      }),
    ).rejects.toThrow("cancelled");
    expect(docker).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
  it("restart cleanup refuses foreign containers and never removes volumes or networks", async () => {
    const id = pythonStackIdentity("a");
    docker.mockImplementation(async (args) => {
      if (args[0] === "ps")
        return args.includes(`name=^/${id.container("mysql")}$`) ? id.container("mysql") : "";
      if (args[0] === "container" && args[1] === "inspect")
        return JSON.stringify([{ Id: "foreign", Config: { Labels: labels("other", "mysql") } }]);
      throw new Error("unexpected mutation");
    });
    await expect(stopPythonStack("a")).rejects.toThrow(/cleanup/);
    expect(docker.mock.calls.some(([args]) => args[0] === "rm")).toBe(false);
    expect(docker.mock.calls.some(([args]) => args[0] === "volume" || args[0] === "network")).toBe(
      false,
    );
  });
  it("restart cleanup removes verified immutable container IDs only", async () => {
    const id = pythonStackIdentity("a");
    let present = true;
    docker.mockImplementation(async (args) => {
      if (args[0] === "ps")
        return present && args.includes(`name=^/${id.container("worker")}$`)
          ? id.container("worker")
          : "";
      if (args[0] === "container")
        return JSON.stringify([
          { Id: "owned-immutable-id", Config: { Labels: labels("a", "worker") } },
        ]);
      if (args[0] === "rm") {
        present = false;
        return "";
      }
      throw new Error("unexpected command");
    });
    await stopPythonStack("a");
    expect(docker).toHaveBeenCalledWith(["rm", "--force", "owned-immutable-id"], undefined, 60_000);
  });
  it("automatically connects business services to owned egress before start while keeping data internal", async () => {
    const options = await runtimeFixture();
    const handle = await startPythonStack(options);
    expect(handle.target).toBe("http://127.0.0.1:9000");
    const { id } = options;
    const commands = docker.mock.calls.map(([args]) => args);
    expect(commands).toContainEqual([
      "network",
      "create",
      "--driver",
      "bridge",
      "--label",
      `${owner}=1`,
      "--label",
      `${owner}.project=${id.key}`,
      "--label",
      `${owner}.role=egress-network`,
      "--label",
      `com.docker.compose.project=gs-python-${id.key.slice(0, 8)}`,
      "--label",
      "com.docker.compose.service=egress-network",
      id.egressNetwork,
    ]);
    expect(commands).toContainEqual([
      "network",
      "create",
      "--internal",
      "--label",
      `${owner}=1`,
      "--label",
      `${owner}.project=${id.key}`,
      "--label",
      `${owner}.role=network`,
      "--label",
      `com.docker.compose.project=gs-python-${id.key.slice(0, 8)}`,
      "--label",
      "com.docker.compose.service=network",
      id.network,
    ]);
    for (const role of ["bootstrap", "backend", "worker", "beat"] as const) {
      const name = id.container(role);
      const createIndex = commands.findIndex((args) => args[0] === "create" && args.includes(name));
      const connectIndex = commands.findIndex(
        (args) => args.join(" ") === ["network", "connect", id.egressNetwork, name].join(" "),
      );
      const startIndex = commands.findIndex((args) => args[0] === "start" && args.includes(name));
      expect(createIndex).toBeGreaterThanOrEqual(0);
      expect(connectIndex).toBeGreaterThan(createIndex);
      expect(startIndex).toBeGreaterThan(connectIndex);
      const create = commands[createIndex];
      expect(create[create.indexOf("--network") + 1]).toBe(id.network);
      expect(create[create.indexOf("--add-host") + 1]).toBe("host.docker.internal:host-gateway");
      expect(create[create.indexOf("--env") + 1]).toBe(
        "MODEL_ENDPOINT_HOST_ALIAS=host.docker.internal",
      );
    }
    for (const role of ["mysql", "redis"] as const) {
      const name = id.container(role);
      const create = commands.find((args) => args[0] === "create" && args.includes(name))!;
      expect(create[create.indexOf("--network") + 1]).toBe(id.network);
      expect(create).not.toContain("--add-host");
      expect(create).not.toContain("--publish");
      expect(
        commands.some(
          (args) => args[0] === "network" && args[1] === "connect" && args.includes(name),
        ),
      ).toBe(false);
    }
    expect(
      commands.filter(
        (args) => args[0] === "network" && args[1] === "connect" && args[2] === id.egressNetwork,
      ),
    ).toHaveLength(4);
    expect(commands.flat()).not.toContain("--privileged");
    expect(commands.flat().some((arg) => arg.includes("docker.sock"))).toBe(false);
    expect(commands.some((args) => args.includes("host") && args.includes("--network"))).toBe(
      false,
    );
    await handle.stop();
    expect(
      docker.mock.calls.some(
        ([args]) => ["network", "volume"].includes(args[0]) && args[1] === "rm",
      ),
    ).toBe(false);
  });
  it("reuses an owned noninternal bridge without replacing the internal data network", async () => {
    const options = await runtimeFixture({ Internal: false });
    await startPythonStack(options);
    expect(
      docker.mock.calls.some(
        ([args]) =>
          args[0] === "network" && args[1] === "create" && args.includes(options.id.egressNetwork),
      ),
    ).toBe(false);
  });
  it.each([
    { Internal: true },
    { Internal: undefined },
    { Internal: false, Driver: "overlay" },
    { Internal: false, Labels: labels("other-project", "egress-network") },
    { Internal: false, Labels: labels("runtime-network-test", "network") },
  ])("refuses unsafe or foreign egress without attaching applications: %j", async (egress) => {
    const options = await runtimeFixture(egress);
    await expect(startPythonStack(options)).rejects.toThrow("No credentials");
    expect(
      docker.mock.calls.some(
        ([args]) => args[0] === "network" && ["connect", "rm"].includes(args[1]),
      ),
    ).toBe(false);
    expect(docker.mock.calls.some(([args]) => args[0] === "create")).toBe(false);
  });
  it("does not treat daemon inspection failure as permission to create resources", async () => {
    await backend();
    docker.mockRejectedValue(new Error("DATABASE_URL=mysql://secret@host"));
    const log = vi.fn();
    await expect(
      startPythonStack({ projectId: "a", projectDir: root, port: 9000, log }),
    ).rejects.toThrow("No credentials");
    expect(log).not.toHaveBeenCalled();
    expect(docker.mock.calls.some(([args]) => ["create", "rm", "pull"].includes(args[0]))).toBe(
      false,
    );
  });
});
