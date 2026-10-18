import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { dependencyDocker } from "../agents/codex-dependency-network";
import { assertPythonResourceLabels, pythonStackIdentity } from "./python-stack";

const OWNER = "io.graduatestudio.python-runtime";
const IMMUTABLE_ID = /^[a-f0-9]{64}$/;
const ALIAS = "gs-model-upstream";
const active = new Set<string>();

/** Platform-authored authorization only; never write this from project source or requests. */
export interface PythonModelRelayConfig {
  version: 1;
  projectId: string;
  targetContainer: "workbuddy2api";
  targetPort: 7863;
  targetId: string;
  targetNetwork: { id: string; name: string };
}
export interface PythonModelRelayHandle {
  target: string;
}
type Labels = Record<string, string>;
interface Container {
  Id: string;
  Name: string;
  Labels: Labels;
  State: { Running?: boolean };
  Networks: Record<string, { NetworkID: string; Aliases?: string[] }>;
}
interface Network {
  Id: string;
  Name: string;
  Labels: Labels;
  Internal: boolean;
  Containers: Record<string, unknown> | null;
}

// Absolute fixed destination, bounded lifetime/concurrency, no request parsing or payload logging.
const BRIDGE = `const net=require('node:net');let count=0;const server=net.createServer(a=>{if(count>=256){a.destroy();return;}count++;const b=net.connect(7863,'gs-model-upstream');const end=()=>{a.destroy();b.destroy();};const timer=setTimeout(end,120000);a.on('close',()=>{clearTimeout(timer);count--;b.destroy();});b.on('close',()=>a.destroy());a.on('error',end);b.on('error',end);a.pipe(b);b.pipe(a);});server.on('error',()=>process.exit(1));server.listen(7863,'0.0.0.0');`;
const CONTAINER_FORMAT =
  '{"Id":{{json .Id}},"Name":{{json .Name}},"Labels":{{json .Config.Labels}},"State":{"Running":{{json .State.Running}}},"Networks":{{json .NetworkSettings.Networks}}}';
const NETWORK_FORMAT =
  '{"Id":{{json .Id}},"Name":{{json .Name}},"Labels":{{json .Labels}},"Internal":{{json .Internal}},"Containers":{{json .Containers}}}';
const run = (args: string[], signal?: AbortSignal) => dependencyDocker(args, signal, 30_000);

async function readConfig(projectId: string): Promise<PythonModelRelayConfig | null> {
  const { key } = pythonStackIdentity(projectId);
  const directory = path.resolve(process.cwd(), ".runtime", "python-model-relays");
  let current = path.parse(directory).root;
  try {
    for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const stat = await fsp.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe relay state path.");
      if (current === directory || current === path.dirname(directory)) {
        if (
          process.platform !== "win32" &&
          ((stat.mode & 0o022) !== 0 || stat.uid !== process.getuid?.())
        )
          throw new Error("Relay state must be platform-private.");
      }
    }
    const file = path.join(directory, `${key}.json`);
    const stat = await fsp.lstat(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 4096 ||
      (process.platform !== "win32" &&
        ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
    )
      throw new Error("Unsafe relay authorization file.");
    const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let config: PythonModelRelayConfig;
    try {
      const opened = await handle.stat();
      if (
        opened.ino !== stat.ino ||
        opened.dev !== stat.dev ||
        opened.size > 4096 ||
        opened.nlink !== 1
      )
        throw new Error("Relay authorization changed while opening.");
      config = JSON.parse(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
    if (
      !config ||
      typeof config !== "object" ||
      Object.keys(config).sort().join() !==
        "projectId,targetContainer,targetId,targetNetwork,targetPort,version" ||
      config.version !== 1 ||
      config.projectId !== projectId ||
      config.targetContainer !== "workbuddy2api" ||
      config.targetPort !== 7863 ||
      typeof config.targetId !== "string" ||
      !IMMUTABLE_ID.test(config.targetId) ||
      !config.targetNetwork ||
      Object.keys(config.targetNetwork).sort().join() !== "id,name" ||
      typeof config.targetNetwork.id !== "string" ||
      !IMMUTABLE_ID.test(config.targetNetwork.id) ||
      typeof config.targetNetwork.name !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(config.targetNetwork.name)
    )
      throw new Error("Invalid relay authorization; platform reauthorization required.");
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Invalid or unsafe Python model relay authorization.");
  }
}

async function inspectContainer(name: string, signal?: AbortSignal): Promise<Container | null> {
  const names = (
    await run(["ps", "--all", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"], signal)
  )
    .trim()
    .split(/\r?\n/);
  if (!names.includes(name)) return null;
  const result: Container = JSON.parse(
    await run(["container", "inspect", name, "--format", CONTAINER_FORMAT], signal),
  );
  if (!IMMUTABLE_ID.test(result.Id) || result.Name !== `/${name}`)
    throw new Error("Relay container identity mismatch.");
  return result;
}
async function inspectNetwork(name: string, signal?: AbortSignal): Promise<Network | null> {
  const names = (
    await run(["network", "ls", "--filter", `name=^${name}$`, "--format", "{{.Name}}"], signal)
  )
    .trim()
    .split(/\r?\n/);
  if (!names.includes(name)) return null;
  const result: Network = JSON.parse(
    await run(["network", "inspect", name, "--format", NETWORK_FORMAT], signal),
  );
  if (!IMMUTABLE_ID.test(result.Id) || result.Name !== name)
    throw new Error("Relay network identity mismatch.");
  return result;
}
function ownedNetwork(network: Network, projectId: string, role: string) {
  assertPythonResourceLabels(network.Labels, projectId, role);
  if (network.Internal !== true) throw new Error("Relay networks must be internal.");
}
function labels(projectId: string, role: string) {
  return [
    "--label",
    `${OWNER}=1`,
    "--label",
    `${OWNER}.project=${pythonStackIdentity(projectId).key}`,
    "--label",
    `${OWNER}.role=${role}`,
  ];
}
async function exclusive<T>(projectId: string, action: () => Promise<T>): Promise<T> {
  const { key } = pythonStackIdentity(projectId);
  if (active.has(key)) throw new Error("Python model relay operation already in progress.");
  active.add(key);
  try {
    return await action();
  } catch {
    throw new Error(
      "Python model relay operation failed closed; platform authorization or cleanup requires attention.",
    );
  } finally {
    active.delete(key);
  }
}

/** No config means no Docker calls, filesystem writes, model calls or implicit enablement. */
export async function ensurePythonModelRelay(
  projectId: string,
  signal?: AbortSignal,
): Promise<PythonModelRelayHandle | null> {
  return exclusive(projectId, async () => {
    signal?.throwIfAborted();
    const config = await readConfig(projectId);
    if (!config) return null;
    const id = pythonStackIdentity(projectId);
    const name = `${id.prefix}-model-relay`,
      networkName = `${id.prefix}-model-net`;
    // Verify pinned original identity, but NEVER attach the relay to that network.
    const target = await inspectContainer(config.targetContainer, signal);
    const original = await inspectNetwork(config.targetNetwork.name, signal);
    if (
      !target ||
      target.Id !== config.targetId ||
      !target.State.Running ||
      !original ||
      original.Id !== config.targetNetwork.id ||
      target.Networks?.[original.Name]?.NetworkID !== original.Id ||
      !Object.hasOwn(original.Containers ?? {}, target.Id) ||
      original.Name === networkName
    )
      throw new Error("Pinned upstream changed; platform reauthorization required.");
    const project = await inspectNetwork(id.network, signal);
    if (!project) throw new Error("Project runtime network unavailable.");
    ownedNetwork(project, projectId, "network");
    if (Object.hasOwn(target.Networks, project.Name))
      throw new Error("Upstream must not join project network.");
    let network = await inspectNetwork(networkName, signal);
    if (network) ownedNetwork(network, projectId, "model-network");
    const existing = await inspectContainer(name, signal);
    if (existing) assertPythonResourceLabels(existing.Labels, projectId, "model-relay");
    if (
      network &&
      Object.keys(network.Containers ?? {}).some(
        (member) => member !== target.Id && member !== existing?.Id,
      )
    )
      throw new Error("Unexpected model network member.");
    if (!network) {
      await run(
        ["network", "create", "--internal", ...labels(projectId, "model-network"), networkName],
        signal,
      );
      network = await inspectNetwork(networkName, signal);
      if (!network) throw new Error("Model network creation unconfirmed.");
      ownedNetwork(network, projectId, "model-network");
    }
    if (!target.Networks[networkName])
      await run(["network", "connect", "--alias", ALIAS, network.Id, target.Id], signal);
    else if (
      target.Networks[networkName].NetworkID !== network.Id ||
      !target.Networks[networkName].Aliases?.includes(ALIAS)
    )
      throw new Error("Upstream model network alias mismatch.");
    // Always replace owned relays: never trust stale command, mounts, image, ports or extra networks.
    if (existing) await run(["rm", "--force", existing.Id], signal);
    const image = JSON.parse(
      await run(
        [
          "image",
          "inspect",
          "gs-codex-worker:0.150.1",
          "--format",
          '{"Id":{{json .Id}},"Os":{{json .Os}}}',
        ],
        signal,
      ),
    ) as { Id: string; Os: string };
    if (image.Os !== "linux" || !/^sha256:[a-f0-9]{64}$/.test(image.Id))
      throw new Error("Pinned worker image unavailable.");
    const created = (
      await run(
        [
          "create",
          "--pull",
          "never",
          "--name",
          name,
          ...labels(projectId, "model-relay"),
          "--network",
          project.Id,
          "--user",
          "10001:10001",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--pids-limit",
          "64",
          "--memory",
          "128m",
          "--cpus",
          "0.5",
          "--log-driver",
          "none",
          "--entrypoint",
          "node",
          image.Id,
          "-e",
          BRIDGE,
        ],
        signal,
      )
    ).trim();
    if (!IMMUTABLE_ID.test(created)) throw new Error("Relay creation unconfirmed.");
    await run(["network", "connect", network.Id, created], signal);
    await run(["start", created], signal);
    const ready = await inspectContainer(name, signal);
    if (
      !ready ||
      ready.Id !== created ||
      !ready.State.Running ||
      Object.keys(ready.Networks).length !== 2 ||
      ready.Networks[project.Name]?.NetworkID !== project.Id ||
      ready.Networks[network.Name]?.NetworkID !== network.Id
    )
      throw new Error("Relay readiness unconfirmed.");
    assertPythonResourceLabels(ready.Labels, projectId, "model-relay");
    return { target: `http://${name}:7863` };
  });
}

/** Only owned relay/network are deleted; target, original network and authorization survive. */
export async function stopPythonModelRelay(projectId: string, signal?: AbortSignal): Promise<void> {
  return exclusive(projectId, async () => {
    signal?.throwIfAborted();
    const config = await readConfig(projectId);
    if (!config) return;
    const id = pythonStackIdentity(projectId);
    const relay = await inspectContainer(`${id.prefix}-model-relay`, signal);
    const network = await inspectNetwork(`${id.prefix}-model-net`, signal);
    if (relay) assertPythonResourceLabels(relay.Labels, projectId, "model-relay");
    if (network) {
      ownedNetwork(network, projectId, "model-network");
      if (
        network.Id === config.targetNetwork.id ||
        Object.keys(network.Containers ?? {}).some(
          (member) => member !== config.targetId && member !== relay?.Id,
        )
      )
        throw new Error("Unexpected model network identity or member.");
    }
    if (relay) {
      await run(["rm", "--force", relay.Id], signal);
      if (await inspectContainer(`${id.prefix}-model-relay`, signal))
        throw new Error("Relay removal unconfirmed.");
    }
    if (network) {
      if (Object.hasOwn(network.Containers ?? {}, config.targetId))
        await run(["network", "disconnect", network.Id, config.targetId], signal);
      await run(["network", "rm", network.Id], signal);
      if (await inspectNetwork(network.Name, signal))
        throw new Error("Model network removal unconfirmed.");
    }
  });
}
