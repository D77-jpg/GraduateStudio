import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

vi.mock("../../src/server/agents/codex-dependency-network", () => ({
  dependencyDocker: vi.fn(),
  withDependencyNetwork: vi.fn(),
}));
import { dependencyDocker } from "../../src/server/agents/codex-dependency-network";
import { pythonStackIdentity } from "../../src/server/runtime/python-stack";
import {
  ensurePythonModelRelay,
  stopPythonModelRelay,
} from "../../src/server/runtime/python-model-relay";

const docker = vi.mocked(dependencyDocker);
const project = "cmv9krh9p0001ub64kc0o8bse";
const identity = pythonStackIdentity(project);
const relayName = `${identity.prefix}-model-relay`;
const modelNet = `${identity.prefix}-model-net`;
const ids = {
  target: "a".repeat(64),
  original: "b".repeat(64),
  project: "c".repeat(64),
  network: "d".repeat(64),
  relay: "e".repeat(64),
  image: `sha256:${"f".repeat(64)}`,
};
const owner = "io.graduatestudio.python-runtime";
const labels = (role: string, key = identity.key) => ({
  [owner]: "1",
  [`${owner}.project`]: key,
  [`${owner}.role`]: role,
});
const validConfig = () => ({
  version: 1,
  projectId: project,
  targetContainer: "workbuddy2api",
  targetPort: 7863,
  targetId: ids.target,
  targetNetwork: { id: ids.original, name: "workbuddy-original" },
});
let root: string;
let cwd: ReturnType<typeof vi.spyOn>;
let configFile: string;
// Minimal in-memory Docker model: never launches containers or calls a model.
interface TestContainer {
  Id: string;
  Name: string;
  Labels: Record<string, string>;
  State: { Running: boolean };
  Networks: Record<string, { NetworkID: string; Aliases: string[] }>;
}
interface TestNetwork {
  Id: string;
  Name: string;
  Internal: boolean;
  Labels: Record<string, string>;
  Containers: Record<string, Record<string, never>>;
}
let containers: Record<string, TestContainer>;
let networks: Record<string, TestNetwork>;
function endpoint(networkId: string, aliases: string[] = []) {
  return { NetworkID: networkId, Aliases: aliases };
}
async function authorize(config: unknown = validConfig(), projectId = project) {
  const directory = path.join(root, ".runtime", "python-model-relays");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  configFile = path.join(directory, `${pythonStackIdentity(projectId).key}.json`);
  await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
}
function ownedRelay(extraNetwork = false) {
  containers[relayName] = {
    Id: ids.relay,
    Name: `/${relayName}`,
    Labels: labels("model-relay"),
    State: { Running: true },
    Networks: {
      [identity.network]: endpoint(ids.project),
      [modelNet]: endpoint(ids.network),
      ...(extraNetwork ? { bridge: endpoint("9".repeat(64)) } : {}),
    },
  };
  networks[modelNet] = {
    Id: ids.network,
    Name: modelNet,
    Labels: labels("model-network"),
    Internal: true,
    Containers: { [ids.target]: {}, [ids.relay]: {} },
  };
  containers.workbuddy2api.Networks[modelNet] = endpoint(ids.network, ["gs-model-upstream"]);
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gs-model-relay-"));
  cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
  containers = {
    workbuddy2api: {
      Id: ids.target,
      Name: "/workbuddy2api",
      Labels: {},
      State: { Running: true },
      Networks: { "workbuddy-original": endpoint(ids.original) },
    },
  };
  networks = {
    "workbuddy-original": {
      Id: ids.original,
      Name: "workbuddy-original",
      Internal: false,
      Labels: {},
      Containers: { [ids.target]: {} },
    },
    [identity.network]: {
      Id: ids.project,
      Name: identity.network,
      Internal: true,
      Labels: labels("network"),
      Containers: {},
    },
  };
  docker.mockReset();
  docker.mockImplementation(async (args) => {
    if (args[0] === "ps") {
      const filter = args.find((a) => a.startsWith("name=^/"));
      const name = filter!.slice(7, -1);
      return containers[name] ? name : "";
    }
    if (args[0] === "container" && args[1] === "inspect")
      return JSON.stringify(containers[args[2]]);
    if (args[0] === "network" && args[1] === "ls") {
      const filter = args.find((a) => a.startsWith("name=^"));
      const name = filter!.slice(6, -1);
      return networks[name] ? name : "";
    }
    if (args[0] === "network" && args[1] === "inspect") return JSON.stringify(networks[args[2]]);
    if (args[0] === "network" && args[1] === "create") {
      networks[modelNet] = {
        Id: ids.network,
        Name: modelNet,
        Internal: true,
        Labels: labels("model-network"),
        Containers: {},
      };
      return ids.network;
    }
    if (args[0] === "image") return JSON.stringify({ Id: ids.image, Os: "linux" });
    if (args[0] === "create") {
      containers[relayName] = {
        Id: ids.relay,
        Name: `/${relayName}`,
        Labels: labels("model-relay"),
        State: { Running: false },
        Networks: { [identity.network]: endpoint(ids.project) },
      };
      networks[identity.network].Containers[ids.relay] = {};
      return ids.relay;
    }
    if (args[0] === "network" && ["connect", "disconnect"].includes(args[1])) {
      const netId = args.at(-2)!;
      const containerId = args.at(-1)!;
      const network = Object.values(networks).find((n) => n.Id === netId);
      const container = Object.values(containers).find((c) => c.Id === containerId);
      if (!network || !container) throw new Error("Unknown network or container");
      if (args[1] === "connect") {
        network.Containers[containerId] = {};
        container.Networks[network.Name] = endpoint(
          netId,
          args.includes("--alias") ? ["gs-model-upstream"] : [],
        );
      } else {
        delete network.Containers[containerId];
        delete container.Networks[network.Name];
      }
      return "";
    }
    if (args[0] === "start") {
      containers[relayName].State.Running = true;
      return "";
    }
    if (args[0] === "rm") {
      const name = Object.keys(containers).find((n) => containers[n].Id === args[2]);
      if (!name) throw new Error("missing container");
      delete containers[name];
      for (const network of Object.values(networks)) delete network.Containers[args[2]];
      return "";
    }
    if (args[0] === "network" && args[1] === "rm") {
      const name = Object.keys(networks).find((n) => networks[n].Id === args[2]);
      if (!name) throw new Error("missing network");
      delete networks[name];
      return "";
    }
    throw new Error(`Unexpected Docker command: ${args[0]}`);
  });
});
afterEach(async () => {
  cwd.mockRestore();
  await fs.rm(root, { recursive: true, force: true });
});
const mutations = () =>
  docker.mock.calls.filter(
    ([a]) =>
      ["create", "rm", "start"].includes(a[0]) ||
      (a[0] === "network" && ["create", "connect", "disconnect", "rm"].includes(a[1])),
  );

describe("platform opt-in Python model relay", () => {
  it("does absolutely no Docker work or state creation without explicit config", async () => {
    expect(await ensurePythonModelRelay(project)).toBeNull();
    await stopPythonModelRelay(project);
    expect(docker).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
    await authorize();
    expect(await ensurePythonModelRelay("other-project")).toBeNull();
    expect(docker).not.toHaveBeenCalled();
  });
  it("uses hashed traversal-proof config paths", async () => {
    const traversal = "../../outside";
    expect(await ensurePythonModelRelay(traversal)).toBeNull();
    await authorize({ ...validConfig(), projectId: traversal }, traversal);
    expect(path.basename(configFile)).toMatch(/^[a-f0-9]{64}\.json$/);
    await expect(ensurePythonModelRelay(traversal)).rejects.toThrow();
  });
  it.each([
    { version: 2 },
    { projectId: "other" },
    { targetContainer: "other" },
    { targetPort: 443 },
    { targetId: "workbuddy2api" },
    { targetNetwork: { id: ids.original, name: "bad/name" } },
    { targetNetwork: { id: "short", name: "network" } },
    { destination: "https://example.com" },
    { targetNetwork: { id: ids.original, name: "network", extra: true } },
  ])("fails closed on invalid authorization %j without Docker", async (change) => {
    await authorize({ ...validConfig(), ...change });
    await expect(ensurePythonModelRelay(project)).rejects.toThrow(/failed closed/);
    expect(docker).not.toHaveBeenCalled();
  });
  it("rejects directories, hard links and oversized files", async () => {
    await authorize();
    await fs.rm(configFile);
    await fs.mkdir(configFile);
    await expect(ensurePythonModelRelay(project)).rejects.toThrow();
    await fs.rm(configFile, { recursive: true });
    await authorize();
    await fs.link(configFile, path.join(root, "linked.json"));
    await expect(ensurePythonModelRelay(project)).rejects.toThrow();
    await fs.rm(path.join(root, "linked.json"));
    await fs.writeFile(configFile, " ".repeat(4097));
    await expect(ensurePythonModelRelay(project)).rejects.toThrow();
    expect(docker).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform === "win32")(
    "rejects symlink paths and permissive config files",
    async () => {
      await authorize();
      await fs.chmod(configFile, 0o644);
      await expect(ensurePythonModelRelay(project)).rejects.toThrow();
      await fs.chmod(configFile, 0o600);
      await fs.rename(path.dirname(configFile), path.join(root, "real-config"));
      await fs.symlink(path.join(root, "real-config"), path.dirname(configFile), "dir");
      await expect(ensurePythonModelRelay(project)).rejects.toThrow();
      expect(docker).not.toHaveBeenCalled();
    },
  );
  it("creates only a hardened fixed TCP relay on two internal networks", async () => {
    await authorize();
    expect(await ensurePythonModelRelay(project)).toEqual({ target: `http://${relayName}:7863` });
    const create = docker.mock.calls.find(([a]) => a[0] === "create")![0];
    expect(create).toEqual(
      expect.arrayContaining([
        "--pull",
        "never",
        "--user",
        "10001:10001",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--log-driver",
        "none",
        "--pids-limit",
        "64",
        "--memory",
        "128m",
        ids.image,
      ]),
    );
    for (const forbidden of [
      "--publish",
      "-p",
      "--env",
      "--env-file",
      "--mount",
      "--volume",
      "bridge",
      "host",
      "latest",
      ids.original,
    ])
      expect(create).not.toContain(forbidden);
    const script = create.at(-1)!;
    expect(script).toContain("net.connect(7863,'gs-model-upstream')");
    expect(script).toContain("count>=256");
    expect(script).toContain("setTimeout(end,120000)");
    expect(script).not.toMatch(/console|process\.env|fetch|http\.request/);
    const connect = docker.mock.calls
      .filter(([a]) => a[0] === "network" && a[1] === "connect")
      .map(([a]) => a);
    expect(connect).toEqual([
      ["network", "connect", "--alias", "gs-model-upstream", ids.network, ids.target],
      ["network", "connect", ids.network, ids.relay],
    ]);
    expect(Object.keys(containers[relayName].Networks).sort()).toEqual(
      [identity.network, modelNet].sort(),
    );
    expect(Object.keys(containers.workbuddy2api.Networks).sort()).toEqual(
      ["workbuddy-original", modelNet].sort(),
    );
    expect(networks[modelNet].Internal).toBe(true);
    expect(networks[identity.network].Internal).toBe(true);
  });
  it("reconciles an owned stale relay without retaining an extra network", async () => {
    await authorize();
    ownedRelay(true);
    await ensurePythonModelRelay(project);
    await ensurePythonModelRelay(project);
    expect(docker.mock.calls.filter(([a]) => a[0] === "network" && a[1] === "create")).toHaveLength(
      0,
    );
    expect(Object.keys(containers[relayName].Networks)).toHaveLength(2);
    expect(
      docker.mock.calls.filter(([a]) => a[0] === "rm").every(([a]) => a[2] === ids.relay),
    ).toBe(true);
  });
  it.each([
    "replacement",
    "original-network",
    "stopped",
    "foreign-project",
    "foreign-model",
    "external-model",
    "foreign-relay",
    "unexpected-member",
  ])("refuses %s before mutation", async (reason) => {
    await authorize();
    if (reason === "replacement") containers.workbuddy2api.Id = "1".repeat(64);
    if (reason === "original-network") networks["workbuddy-original"].Id = "2".repeat(64);
    if (reason === "stopped") containers.workbuddy2api.State.Running = false;
    if (reason === "foreign-project")
      networks[identity.network].Labels = labels("network", "other");
    if (["foreign-model", "external-model", "foreign-relay", "unexpected-member"].includes(reason))
      ownedRelay();
    if (reason === "foreign-model") networks[modelNet].Labels = labels("network");
    if (reason === "external-model") networks[modelNet].Internal = false;
    if (reason === "foreign-relay") containers[relayName].Labels = labels("backend");
    if (reason === "unexpected-member") networks[modelNet].Containers["9".repeat(64)] = {};
    await expect(ensurePythonModelRelay(project)).rejects.toThrow(/failed closed/);
    expect(mutations()).toEqual([]);
  });
  it("does not reinterpret daemon errors as absence or leak output", async () => {
    await authorize();
    docker.mockRejectedValue(new Error("UPSTREAM_SECRET"));
    await expect(ensurePythonModelRelay(project)).rejects.toThrow(/failed closed/);
    expect(mutations()).toEqual([]);
  });
  it("stop preserves target, original/project networks, config and unrelated services", async () => {
    await authorize();
    ownedRelay();
    const originalConfig = await fs.readFile(configFile, "utf8");
    await stopPythonModelRelay(project);
    expect(mutations().map(([a]) => a)).toEqual([
      ["rm", "--force", ids.relay],
      ["network", "disconnect", ids.network, ids.target],
      ["network", "rm", ids.network],
    ]);
    expect(containers.workbuddy2api.Id).toBe(ids.target);
    expect(networks["workbuddy-original"].Id).toBe(ids.original);
    expect(networks[identity.network].Id).toBe(ids.project);
    expect(await fs.readFile(configFile, "utf8")).toBe(originalConfig);
    await stopPythonModelRelay(project);
    expect(mutations()).toHaveLength(3);
  });
  it("stop never disconnects a replacement target by name", async () => {
    await authorize();
    ownedRelay();
    delete networks[modelNet].Containers[ids.target];
    containers.workbuddy2api.Id = "1".repeat(64);
    await stopPythonModelRelay(project);
    expect(mutations().map(([a]) => a)).toEqual([
      ["rm", "--force", ids.relay],
      ["network", "rm", ids.network],
    ]);
  });
  it("stop refuses a foreign network or relay without modifying anything", async () => {
    await authorize();
    ownedRelay();
    networks[modelNet].Labels = labels("model-network", "other");
    await expect(stopPythonModelRelay(project)).rejects.toThrow();
    expect(mutations()).toEqual([]);
    networks[modelNet].Labels = labels("model-network");
    containers[relayName].Labels = labels("worker");
    await expect(stopPythonModelRelay(project)).rejects.toThrow();
    expect(mutations()).toEqual([]);
  });
  it("honors cancellation before any Docker action", async () => {
    await authorize();
    const controller = new AbortController();
    controller.abort();
    await expect(ensurePythonModelRelay(project, controller.signal)).rejects.toThrow();
    await expect(stopPythonModelRelay(project, controller.signal)).rejects.toThrow();
    expect(docker).not.toHaveBeenCalled();
  });
});
