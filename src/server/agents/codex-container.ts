import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { isIPv4 } from "node:net";

function publicIPv4(ip: string): boolean {
  if (!isIPv4(ip)) return false;
  const [a, b] = ip.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || b === 2)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0)
  );
}
import { CodexEngine } from "./adapters/codex";
import { safeCodexDiagnostic } from "./adapters/codex-jsonl";
import { verifyDesignSkillBundle } from "./design-skill-bundle";
import type { AgentEngine, CodexSpawn } from "./engine";

const IMAGE = "gs-codex-worker:0.150.1";
const ISOLATION = "docker-linux-network-none-unix-broker";

// Never include Docker output in exceptions: inspect/env/daemon diagnostics may contain secrets.
function docker(
  args: string[],
  signal?: AbortSignal,
  extraEnv?: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
      signal,
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      if (output.length < 65536) output += String(chunk).slice(0, 65536 - output.length);
    });
    child.stderr.resume();
    const timeout = setTimeout(() => child.kill(), 30000);
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("Isolated Codex Docker operation failed."));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(output.trim());
      else reject(new Error("Isolated Codex Docker operation failed."));
    });
  });
}

async function credential(): Promise<string> {
  const explicit = process.env.GS_CODEX_API_KEY?.trim();
  if (explicit) return explicit;
  // Deliberately extract only a literal bearer, never copy personal config, auth.json or env.
  let text = "";
  try {
    text = await readFile(path.join(homedir(), ".codex", "config.toml"), "utf8");
  } catch {
    /* absent */
  }
  const tokens = [
    ...[
      ...text.matchAll(
        /^\s*(?:experimental_bearer_token|bearer_token)\s*=\s*"([^"\r\n]+)"\s*(?:#.*)?$/gm,
      ),
    ].map((match) => match[1]),
    ...[
      ...text.matchAll(
        /^\s*http_headers\s*=\s*\{\s*"?Authorization"?\s*=\s*"Bearer ([^"\r\n]+)"\s*\}\s*(?:#.*)?$/gim,
      ),
    ].map((match) => match[1]),
    ...[...text.matchAll(/^\s*"?Authorization"?\s*=\s*"Bearer ([^"\r\n]+)"\s*(?:#.*)?$/gim)].map(
      (match) => match[1],
    ),
  ];
  const unique = [...new Set(tokens)];
  if (unique.length !== 1)
    throw new Error("Set GS_CODEX_API_KEY; no unambiguous literal Codex bearer was found.");
  return unique[0];
}

const STAGE_LABEL = "io.graduatestudio.codex.stage";
async function stageIdentity(workspace: string) {
  const stage = await realpath(workspace);
  const canonical = process.platform === "win32" ? stage.toLowerCase() : stage;
  return { stage, owner: createHash("sha256").update(canonical).digest("hex") };
}
async function stageResources(owner: string) {
  const filter = ["--filter", `label=${STAGE_LABEL}=${owner}`, "--format", "{{.ID}}"];
  const containers = (await docker(["ps", "--all", ...filter])).split(/\s+/).filter(Boolean);
  const networks = (await docker(["network", "ls", ...filter])).split(/\s+/).filter(Boolean);
  // Volume ls exposes Name, not ID.
  const volumes = (
    await docker([
      "volume",
      "ls",
      "--filter",
      `label=${STAGE_LABEL}=${owner}`,
      "--format",
      "{{.Name}}",
    ])
  )
    .split(/\s+/)
    .filter(Boolean);
  return { containers, networks, volumes };
}

/** Explicit restart recovery ONLY. Caller must hold an exclusive task/stage lease and establish
 * that the previous owner is dead. Never call on a stage that may still have a live task.
 * Removes only exact hashed-stage labels, never globally reaps GraduateStudio resources.
 */
export async function cleanupCodexStage(workspace: string): Promise<void> {
  const { owner } = await stageIdentity(workspace);
  const resources = await stageResources(owner);
  for (const name of resources.containers) await docker(["rm", "--force", name]);
  for (const name of resources.networks) await docker(["network", "rm", name]);
  for (const name of resources.volumes) await docker(["volume", "rm", "--force", name]);
  const remaining = await stageResources(owner);
  if (remaining.containers.length || remaining.networks.length || remaining.volumes.length)
    throw new Error("Isolated Codex stage cleanup incomplete.");
}

/** The caller MUST supply a disposable stage, not an original project or personal directory. */
export interface IsolatedCodexOptions {
  /** 本轮模型；省略时使用 GS_CODEX_MODEL。规划/修复可用更强模型，批量模块用便宜模型。 */
  model?: string;
  /** 带对应工具链的 worker 镜像（例如含 JDK17+Maven）；不存在时回退基础镜像。 */
  image?: string;
  /** 只读挂载到 /opt/gs-template 的骨架模板，供模型对照约定。 */
  templateRoot?: string | null;
  /** 依赖缓存卷（与交付闸门共享），挂到 /cache；worker 仍断网，只能离线复用已缓存的依赖。 */
  cacheVolume?: string | null;
}

export async function createIsolatedCodexEngine(
  workspace: string,
  signal?: AbortSignal,
  options: IsolatedCodexOptions = {},
): Promise<{
  engine: AgentEngine;
  metadata: {
    model: string;
    isolation: string;
    image: string;
    toolchainFallback: boolean;
    designSkillsRevision: string;
    designSkills: Array<{ id: string; revision: string }>;
  };
  dispose: () => Promise<void>;
}> {
  signal?.throwIfAborted();
  const designBundle = await verifyDesignSkillBundle();
  const { stage, owner } = await stageIdentity(workspace);
  if (!(await stat(stage)).isDirectory() || stage.includes(","))
    throw new Error("Invalid isolated Codex stage path.");
  const model = options.model?.trim() || process.env.GS_CODEX_MODEL?.trim() || "deepseek-flash";
  const upstream = new URL(process.env.GS_CODEX_BASE_URL?.trim() || "https://api.deepseek.com");
  if (
    upstream.protocol !== "https:" ||
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash ||
    (upstream.port && upstream.port !== "443")
  )
    throw new Error("GS_CODEX_BASE_URL must be an HTTPS origin/path without credentials or query.");
  const pinnedIP = process.env.GS_CODEX_UPSTREAM_IP?.trim();
  if (pinnedIP && !publicIPv4(pinnedIP))
    throw new Error("GS_CODEX_UPSTREAM_IP must be a public IPv4 address.");
  const key = await credential();
  if (/[\r\n\0]/.test(key)) throw new Error("Invalid model credential.");
  // Fail closed: image inspect never pulls, and both run commands use --pull never and pinned ID.
  let image: { Id: string; Os: string; Config: { Labels?: Record<string, string> } } | undefined;
  let imageName = IMAGE;
  let toolchainFallback = false;
  if (options.image && options.image !== IMAGE) {
    try {
      image = JSON.parse(
        await docker(["image", "inspect", options.image, "--format", "{{json .}}"], signal),
      );
      imageName = options.image;
    } catch {
      // 工具链镜像未构建：回退基础镜像。agent 将无法在模块内编译该栈，但交付闸门照样会拦住。
      toolchainFallback = true;
    }
  }
  if (!image)
    try {
      image = JSON.parse(await docker(["image", "inspect", IMAGE, "--format", "{{json .}}"], signal));
    } catch {
      throw new Error(
        `Required Linux image ${IMAGE} is unavailable; build docker/codex-worker first. No host fallback.`,
      );
    }
  if (!image) throw new Error("Isolated Codex requires a Linux worker image.");
  const workerImage = image;
  if (workerImage.Os !== "linux" || !/^sha256:[a-f0-9]{64}$/.test(workerImage.Id))
    throw new Error("Isolated Codex requires a Linux worker image.");
  const existing = await stageResources(owner);
  if (existing.containers.length || existing.networks.length || existing.volumes.length)
    throw new Error(
      "Isolated Codex stage is already owned; recover only under an exclusive task lease.",
    );
  const label = `${STAGE_LABEL}=${owner}`;
  const id = `gs-codex-${randomUUID()}`;
  const gateway = `${id}-gateway`,
    volume = `${id}-socket`,
    network = `${id}-egress`;
  const configDir = await mkdtemp(path.join(tmpdir(), "gs-codex-config-"));
  const workers = new Set<string>();
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  const cleanup = async () => {
    const errors: unknown[] = [];
    const remove = async (args: string[]) => {
      try {
        await docker(args);
      } catch (error) {
        errors.push(error);
      }
    };
    await Promise.all([...workers, gateway].map((name) => remove(["rm", "--force", name])));
    await remove(["network", "rm", network]);
    await remove(["volume", "rm", "--force", volume]);
    await rm(configDir, { recursive: true, force: true });
    // Listing must succeed: daemon unavailability is not evidence of successful removal.
    const containers = await docker([
      "ps",
      "--all",
      "--filter",
      `name=${id}`,
      "--format",
      "{{.Names}}",
    ]);
    const networks = await docker([
      "network",
      "ls",
      "--filter",
      `name=${network}`,
      "--format",
      "{{.Name}}",
    ]);
    const volumes = await docker([
      "volume",
      "ls",
      "--filter",
      `name=${volume}`,
      "--format",
      "{{.Name}}",
    ]);
    if (containers || networks || volumes)
      throw new Error("Isolated Codex cleanup incomplete; Docker resources remain.");
    void errors;
  };
  const dispose = () => {
    disposed = true;
    signal?.removeEventListener("abort", abort);
    return (disposePromise ??= cleanup());
  };
  const abort = () => {
    void dispose().catch(() => {
      /* caller still owns awaited disposal */
    });
  };
  try {
    await chmod(configDir, 0o755); // Generated non-secret config must be readable by container uid 10001.
    await writeFile(
      path.join(configDir, "config.toml"),
      [
        `model = ${JSON.stringify(model)}`,
        'model_provider = "gs_broker"',
        "[model_providers.gs_broker]",
        'name = "GraduateStudio isolated broker"',
        'base_url = "http://127.0.0.1:8080"',
        'wire_api = "responses"',
        'env_key = "GS_WORKER_TOKEN"',
        "requires_openai_auth = false",
        "",
      ].join("\n"),
      { mode: 0o644 },
    );
    await docker(["volume", "create", "--label", label, volume], signal);
    await docker(["network", "create", "--driver", "bridge", "--label", label, network], signal);
    await docker(
      [
        "run",
        "--detach",
        // Retain stopped gateway state for a fixed exit-code probe; dispose removes it.
        "--pull",
        "never",
        "--name",
        gateway,
        "--label",
        label,
        "--network",
        network,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "64",
        "--memory",
        "256m",
        "--cpus",
        "1",
        "--log-driver",
        "none",
        "--mount",
        `type=volume,src=${volume},dst=/broker`,
        "--env",
        "GS_BROKER_KEY",
        "--env",
        `GS_UPSTREAM=${upstream.href}`,
        ...(pinnedIP ? ["--env", `GS_CODEX_UPSTREAM_IP=${pinnedIP}`] : []),
        "--entrypoint",
        "node",
        workerImage.Id,
        "/opt/gs/gateway.mjs",
      ],
      signal,
      { GS_BROKER_KEY: key },
    );
    await docker(
      [
        "exec",
        gateway,
        "node",
        "--input-type=module",
        "-e",
        "import fs from 'node:fs'; for(let i=0;i<50;i++){if(fs.existsSync('/broker/api.sock'))process.exit(0);await new Promise(r=>setTimeout(r,100));}process.exit(1)",
      ],
      signal,
    );
    const spawnWorker: CodexSpawn = (_command, args) => {
      if (disposed || signal?.aborted) throw new Error("Isolated Codex is disposed.");
      const name = `${id}-worker-${randomUUID()}`;
      workers.add(name);
      // Translate the host stage path; never mount or pass through adapter environment/config.
      // Clean config has no personal MCP definitions; disabled fragments alone are invalid TOML server definitions.
      const translated = args.filter(
        (arg, index) =>
          !(arg === "-c" && args[index + 1]?.startsWith("mcp_servers.")) &&
          !(args[index - 1] === "-c" && arg.startsWith("mcp_servers.")),
      );
      const cd = translated.indexOf("--cd");
      if (cd !== -1) translated[cd + 1] = "/workspace";
      // Outer Docker boundary supplies confinement; nested Landlock is not portable on Docker Desktop.
      const sandbox = translated.indexOf("--sandbox");
      if (sandbox !== -1) translated[sandbox + 1] = "danger-full-access";
      const child = spawn(
        "docker",
        [
          "run",
          "--rm",
          "--pull",
          "never",
          "--name",
          name,
          "--label",
          label,
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--pids-limit",
          "256",
          "--memory",
          "2g",
          "--cpus",
          "2",
          "--log-driver",
          "none",
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,size=512m,mode=1777",
          "--mount",
          `type=bind,src=${stage},dst=/workspace${args[args.indexOf("--sandbox") + 1] === "read-only" ? ",readonly" : ""}`,
          "--mount",
          `type=bind,src=${configDir},dst=/config,readonly`,
          "--mount",
          `type=bind,src=${designBundle.root},dst=/opt/gs-design-skills,readonly`,
          "--mount",
          `type=volume,src=${volume},dst=/broker,readonly`,
          ...(options.templateRoot
            ? ["--mount", `type=bind,src=${options.templateRoot},dst=/opt/gs-template,readonly`]
            : []),
          ...(options.cacheVolume
            ? [
                "--mount",
                `type=volume,src=${options.cacheVolume},dst=/cache`,
                "--env",
                "GS_M2_REPO=/cache/m2",
                "--env",
                "MAVEN_OPTS=-Dmaven.repo.local=/cache/m2",
                "--env",
                "npm_config_cache=/cache/npm",
                "--env",
                "npm_config_offline=true",
                "--env",
                "PIP_CACHE_DIR=/cache/pip",
              ]
            : []),
          workerImage.Id,
          ...translated,
        ],
        {
          cwd: stage,
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      // Killing docker's client alone does not reliably stop its container.
      const kill = child.kill.bind(child);
      child.kill = (sig) => {
        void docker(["rm", "--force", name]).catch(() => {});
        return kill(sig);
      };
      child.once("close", () => {
        void docker(["rm", "--force", name]).catch(() => {});
      });
      return child;
    };
    const adapter = new CodexEngine(spawnWorker);
    const gatewayStateFailure = async (): Promise<string | null> => {
      // Inspect only fixed state fields. An exec/inspect failure alone proves no lifetime expiry.
      const state = await docker([
        "inspect",
        "--format",
        "{{.State.Running}} {{.State.ExitCode}}",
        gateway,
      ]).catch(() => "");
      if (state === "false 124")
        return "模型代理生命周期已到期（BROKER_LIFETIME_EXPIRED）；保留副本与上下文，请继续任务，不要从头生成。";
      if (/^false \d+$/.test(state))
        return "模型代理已停止（BROKER_STOPPED）；保留副本与上下文，请检查服务后继续。";
      return null;
    };
    let running = false;
    const engine: AgentEngine = {
      id: "codex",
      async run(task, onEvent) {
        if (disposed) throw new Error("Isolated Codex is disposed.");
        if ((await realpath(task.workspace)) !== stage)
          throw new Error("Isolated Codex workspace mismatch.");
        if (running || disposed) throw new Error("Isolated Codex does not permit concurrent runs.");
        running = true;
        const stopContainers = async () => {
          await Promise.all(
            [...workers].map((name) => docker(["rm", "--force", name]).catch(() => {})),
          );
          const remaining = await docker([
            "ps",
            "--all",
            "--filter",
            `name=${id}-worker-`,
            "--format",
            "{{.Names}}",
          ]);
          if (remaining)
            throw new Error("Isolated Codex worker removal failed; results must not be published.");
        };
        const onAbort = () => {
          void stopContainers().catch(() => {});
        };
        task.signal?.addEventListener("abort", onAbort, { once: true });
        try {
          // Clear stale per-attempt diagnostics; broker writes fixed codes only.
          try {
            await docker([
              "exec",
              gateway,
              "node",
              "-e",
              "require('fs').rmSync('/broker/transport-status',{force:true})",
            ]);
          } catch {
            throw new Error(
              (await gatewayStateFailure()) ??
                "模型代理状态检查失败；已保留副本与上下文，请检查服务后继续。",
            );
          }
          const result = await adapter.run(task, onEvent);
          if (result.exitCode !== 0 && !task.signal?.aborted) {
            const code = await docker([
              "exec",
              gateway,
              "node",
              "-e",
              "const f=require('fs');if(f.existsSync('/broker/transport-status'))process.stdout.write(f.readFileSync('/broker/transport-status','utf8'))",
            ]).catch(() => "");
            const stateFailure = await gatewayStateFailure();
            const transportCode =
              /^(?:UPSTREAM_IDLE_TIMEOUT|UPSTREAM_STREAM_ABORTED|UPSTREAM_STREAM_ERROR|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|TRANSPORT_DENIED)$/.test(
                code,
              );
            const message =
              stateFailure ??
              (/^UPSTREAM_HTTP_[1-5][0-9]{2}$/.test(code)
                ? safeCodexDiagnostic(code)
                : transportCode
                  ? `模型连接中断（${code}）；已保留进度，未自动重试。`
                  : null);
            if (message) {
              // Task orchestration observes error events; never overwrite normal lastMessage.
              onEvent?.({ type: "error", runId: result.runId, message });
            }
          }
          return result;
        } finally {
          task.signal?.removeEventListener("abort", onAbort);
          await stopContainers();
          running = false;
        }
      },
      async cancel(runId) {
        await Promise.all(
          [...workers].map((name) => docker(["rm", "--force", name]).catch(() => {})),
        );
        await adapter.cancel(runId);
      },
    };
    signal?.addEventListener("abort", abort, { once: true });
    signal?.throwIfAborted();
    return {
      engine,
      metadata: {
        model,
        isolation: ISOLATION,
        image: imageName,
        toolchainFallback,
        designSkillsRevision: designBundle.revision,
        designSkills: designBundle.skills,
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
