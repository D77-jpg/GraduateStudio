import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

/**
 * Controlled dependency download boundary.
 *
 * The downloader container joins a private, internal Docker network with no
 * default route. Only the dedicated proxy container is additionally attached to
 * the default bridge, and it permits TLS CONNECT to the pinned package
 * registries on port 443 only, resolving each host through a trusted DNS path
 * and rejecting non-public addresses. No project code, credential or host path
 * enters the downloader, and no generated command runs on the host.
 */
const IMAGE = "gs-codex-worker:0.150.1";
export const DEPENDENCY_DOCKER_TIMEOUT_MS = 600_000;
const BRIDGE = "bridge";

interface DockerResult {
  code: number | null;
  output: string;
  interrupted: boolean;
  error: boolean;
  overflow: boolean;
}

/** Only the Docker client runs on the host; the environment is an explicit allowlist. */
function docker(args: string[], signal?: AbortSignal, timeoutMs = 30_000): Promise<DockerResult> {
  return new Promise((resolve) => {
    let output = "",
      bytes = 0,
      interrupted = false,
      error = false,
      overflow = false,
      settled = false;
    const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
    for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP"])
      if (process.env[key]) env[key] = process.env[key];
    const child = spawn("docker", args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    for (const channel of ["stdout", "stderr"] as const)
      child[channel].on("data", (chunk: Buffer) => {
        const available = Math.max(0, 65536 - bytes);
        if (chunk.length > available) overflow = true;
        const accepted = chunk.subarray(0, available);
        bytes += accepted.length;
        output += decoders[channel].write(accepted);
      });
    const stop = () => {
      interrupted = true;
      child.kill();
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (!overflow) output += decoders.stdout.end() + decoders.stderr.end();
      resolve({ code, output, interrupted, error, overflow });
    };
    child.once("error", () => {
      error = true;
      finish(null);
    });
    child.once("close", finish);
  });
}

/** Runs one Docker client invocation and fails closed on any inconclusive result. */
export async function dependencyDocker(
  args: string[],
  signal?: AbortSignal,
  timeoutMs = DEPENDENCY_DOCKER_TIMEOUT_MS,
): Promise<string> {
  const result = await docker(args, signal, timeoutMs);
  if (result.error || result.interrupted || result.overflow || result.code !== 0)
    throw new Error("Dependency container command did not complete successfully.");
  return result.output;
}

async function removeContainer(name: string): Promise<void> {
  await docker(["rm", "--force", name], undefined, 60_000);
  const state = await docker([
    "ps",
    "--all",
    "--filter",
    `name=^/${name}$`,
    "--format",
    "{{.Names}}",
  ]);
  if (state.code !== 0 || state.error || state.interrupted || state.output.trim())
    throw new Error("Dependency container removal could not be confirmed.");
}

async function removeNetwork(name: string): Promise<void> {
  await docker(["network", "rm", name], undefined, 60_000);
  const state = await docker([
    "network",
    "ls",
    "--filter",
    `name=^${name}$`,
    "--format",
    "{{.Name}}",
  ]);
  if (state.code !== 0 || state.error || state.interrupted || state.output.trim())
    throw new Error("Dependency network removal could not be confirmed.");
}

async function pinnedImage(signal?: AbortSignal): Promise<string> {
  const inspected = await docker(["image", "inspect", IMAGE, "--format", "{{json .}}"], signal);
  if (inspected.error || inspected.interrupted || inspected.code !== 0)
    throw new Error("Pinned worker image unavailable.");
  const image = JSON.parse(inspected.output) as { Os?: string; Id?: string };
  if (image.Os !== "linux" || !image.Id || !/^sha256:[a-f0-9]{64}$/.test(image.Id))
    throw new Error("Pinned Linux worker image unavailable.");
  return image.Id;
}

async function waitForProxy(name: string, signal?: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    signal?.throwIfAborted();
    const probe = await docker([
      "exec",
      name,
      "node",
      "-e",
      "require('net').connect(8080,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))",
    ]);
    if (!probe.error && !probe.interrupted && probe.code === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Dependency proxy did not become ready.");
}

export interface DependencyNetworkContext {
  networkName: string;
  proxyUrl: string;
  imageId: string;
}

/**
 * Creates a temporary controlled-egress network, runs the callback with the
 * internal network name plus proxy URL, then removes the proxy and network and
 * verifies that removal. The callback owns and must remove its own downloader
 * containers before resolving.
 */
export async function withDependencyNetwork<T>(
  callback: (context: DependencyNetworkContext) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const id = randomUUID();
  const networkName = `gs-codex-deps-${id}`;
  const proxyName = `gs-codex-deps-proxy-${id}`;
  const label = `io.graduatestudio.codex.deps=${id}`;
  const imageId = await pinnedImage(signal);
  let created = false;
  try {
    await dependencyDocker(
      ["network", "create", "--internal", "--label", label, networkName],
      signal,
      60_000,
    );
    created = true;
    const pins = process.env.GS_DEPENDENCY_PUBLIC_IPS?.trim();
    await dependencyDocker(
      [
        "create",
        "--pull",
        "never",
        "--name",
        proxyName,
        "--network",
        networkName,
        "--label",
        label,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--user",
        "10001:10001",
        "--pids-limit",
        "64",
        "--memory",
        "128m",
        "--cpus",
        "1",
        "--log-driver",
        "none",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=16m,mode=1777",
        ...(pins ? ["--env", "GS_DEPENDENCY_PUBLIC_IPS"] : []),
        "--entrypoint",
        "node",
        imageId,
        "/opt/gs/dependency-proxy.mjs",
      ],
      signal,
      60_000,
    );
    // Only the proxy receives egress; the downloader network stays internal.
    await dependencyDocker(["network", "connect", BRIDGE, proxyName], signal, 60_000);
    await dependencyDocker(["start", proxyName], signal, 60_000);
    await waitForProxy(proxyName, signal);
    return await callback({ networkName, proxyUrl: `http://${proxyName}:8080`, imageId });
  } finally {
    let cleanupFailed = false;
    try {
      await removeContainer(proxyName);
    } catch {
      cleanupFailed = true;
    }
    if (created) {
      try {
        await removeNetwork(networkName);
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed)
      throw new Error("Controlled dependency network cleanup could not be confirmed.");
  }
}
