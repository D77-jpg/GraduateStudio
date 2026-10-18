import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { safeCodexText } from "@/lib/codex-progress";
import type { CodexAcceptanceCheck, CodexAcceptanceResult } from "./codex-acceptance";
import { withDependencyNetwork, dependencyDocker } from "./codex-dependency-network";

const IMAGE = "gs-codex-worker:0.150.1";
const ROOTS = ["", "server", "backend"];
const RESULT_MARKER = "GS_PYTHON_RESULT=";
const REQUIREMENT =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*\])?(?:\s*(?:===|==|!=|~=|<=|>=|<|>)\s*[A-Za-z0-9.*+!_-]+(?:\s*,\s*(?:===|==|!=|~=|<=|>=|<|>)\s*[A-Za-z0-9.*+!_-]+)*)?$/;

async function plainFile(file: string) {
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error("Requirements must be regular files.");
    if (stat.size > 128 * 1024) throw new Error("Requirements file exceeds safety limit.");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Parse metadata only: no URL, VCS, editable/local package, index, hash or installer options. */
export async function collectCodexPythonRequirements(root: string): Promise<string[]> {
  const directory = await fs.realpath(root);
  const seen = new Set<string>();
  const requirements = new Set<string>();
  async function visit(relative: string, depth: number) {
    if (depth > 8 || seen.size >= 16) throw new Error("Requirements include limit exceeded.");
    if (
      !/^[A-Za-z0-9_./-]+\.txt$/.test(relative) ||
      relative.split(/[\\/]/).includes("..") ||
      path.isAbsolute(relative)
    )
      throw new Error("Unsafe requirements include.");
    const file = path.resolve(directory, relative);
    if (file !== directory && !file.startsWith(directory + path.sep))
      throw new Error("Unsafe requirements include.");
    const parts = path.relative(directory, file).split(path.sep);
    let current = directory;
    for (const part of parts) {
      current = path.join(current, part);
      if ((await fs.lstat(current)).isSymbolicLink())
        throw new Error("Symlink requirements refused.");
    }
    if (seen.has(file)) throw new Error("Requirements include cycle refused.");
    seen.add(file);
    if (!(await plainFile(file))) throw new Error("Included requirements file missing.");
    const lines = (await fs.readFile(file, "utf8")).split(/\r?\n/);
    for (const source of lines) {
      const line = source.replace(/\s+#.*$/, "").trim();
      if (!line || line.startsWith("#")) continue;
      const include = /^-r\s+([A-Za-z0-9_./-]+\.txt)$/.exec(line);
      if (include) {
        await visit(path.posix.join(path.posix.dirname(relative), include[1]), depth + 1);
        continue;
      }
      if (line.length > 512 || !REQUIREMENT.test(line))
        throw new Error(
          "Unsupported Python requirement: only package names, extras and version constraints are allowed.",
        );
      requirements.add(line);
      if (requirements.size > 256) throw new Error("Too many Python requirements.");
    }
  }
  const entry = (await plainFile(path.join(directory, "requirements-dev.txt")))
    ? "requirements-dev.txt"
    : "requirements.txt";
  await visit(entry, 0);
  if (![...requirements].some((value) => /^pytest(?:\[|\s|[<>=!~]|$)/i.test(value)))
    requirements.add("pytest>=8.3,<9");
  return [...requirements].sort();
}

const DOWNLOAD_SCRIPT = String.raw`
import os, subprocess, sys
subprocess.run([sys.executable,'-m','venv','/tmp/fetch-env'],check=True)
subprocess.run(['/tmp/fetch-env/bin/python','-m','pip','--isolated','download','--disable-pip-version-check','--no-cache-dir','--only-binary=:all:','--dest','/wheels','--proxy',sys.argv[1],'--index-url','https://pypi.org/simple','-r','/input/requirements.txt'],check=True)
`;
const VERIFY_SCRIPT = String.raw`
import json, os, pathlib, subprocess, sys, time, shlex, xml.etree.ElementTree as ET
checks=[]
def tail(result,limit=2000):
  text=((result.stdout or '')+(result.stderr or '')).strip()
  return text[-limit:]
def run(name,args):
  started=time.monotonic()
  result=subprocess.run(args,capture_output=True,text=True)
  checks.append({'name':name,'status':'passed' if result.returncode==0 else 'failed','exitCode':result.returncode,
    'command':shlex.join(args),'durationMs':round((time.monotonic()-started)*1000),
    'output':'Executed isolated Python command.' if result.returncode==0 else 'Command failed; tail: '+tail(result)})
  return result.returncode==0
root=pathlib.Path.cwd()
venv='/tmp/python-verification-env'
try:
  if run('python:environment',[sys.executable,'-m','venv',venv]):
    py=venv+'/bin/python'
    if run('python:dependencies',[py,'-m','pip','--isolated','install','--no-index','--only-binary=:all:','--find-links','/wheels','--disable-pip-version-check','-r','/input/requirements.txt']):
      sources=[str(p) for p in (root/'app',root/'src') if p.is_dir()]
      if not sources: sources=[str(p) for p in root.glob('*.py')]
      if sources: run('python:compile',[py,'-m','compileall','-q',*sources])
      else: checks.append({'name':'python:compile','status':'blocked','output':'No supported Python source root (app, src or root Python files).'})
      testroots=[str(p) for p in (root/'tests',root/'test') if p.is_dir()]
      if not testroots: checks.append({'name':'python:tests','status':'blocked','output':'No Python tests directory. Tests were not executed.'})
      else:
        report='/tmp/python-tests.xml'
        args=[py,'-m','pytest','-q','-o','addopts=','--junitxml='+report,*testroots]
        started=time.monotonic()
        completed=subprocess.run(args,capture_output=True,text=True)
        execution={'command':shlex.join(args),'durationMs':round((time.monotonic()-started)*1000)}
        evidence=tail(completed,4000)
        try:
          tree=ET.parse(report).getroot()
          suites=[tree] if tree.tag=='testsuite' else list(tree.findall('testsuite'))
          total=sum(int(s.get('tests','0')) for s in suites)
          skipped=sum(int(s.get('skipped','0')) for s in suites)
          failures=sum(int(s.get('failures','0'))+int(s.get('errors','0')) for s in suites)
          status='failed' if failures or completed.returncode not in (0,5) else 'blocked' if total==0 or skipped or completed.returncode!=0 else 'passed'
          details=[]
          for case in tree.iter('testcase'):
            for tag in ('failure','error'):
              for problem in case.findall(tag):
                details.append(case.get('classname','')+'::'+case.get('name','')+' — '+problem.get('message','')[:140])
          failure_summary='\n'.join(details)[:6500]
          checks.append({'name':'python:tests','status':status,'exitCode':completed.returncode,**execution,'output':f'pytest evidence: tests={total}, skipped={skipped}, failures/errors={failures}, returncode={completed.returncode}. This is engineering verification, not business acceptance.\n'+failure_summary+'\n'+evidence})
        except Exception:
          checks.append({'name':'python:tests','status':'failed' if completed.returncode not in (0,5) else 'blocked','exitCode':completed.returncode,**execution,'output':f'No valid pytest execution report; completion not accepted. returncode={completed.returncode}.\n'+evidence})
except Exception:
  checks.append({'name':'python:verification','status':'blocked','output':'Python isolated verification environment unavailable.'})
print('GS_PYTHON_RESULT='+json.dumps(checks),flush=True)
`;

interface DockerResult {
  code: number | null;
  output: string;
  interrupted: boolean;
  error: boolean;
  overflow: boolean;
}
function docker(args: string[], signal?: AbortSignal, timeout = 30_000): Promise<DockerResult> {
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
        const available = Math.max(0, 128 * 1024 - bytes);
        if (chunk.length > available) overflow = true;
        const accepted = chunk.subarray(0, available);
        bytes += accepted.length;
        output += decoders[channel].write(accepted);
      });
    const stop = () => {
      interrupted = true;
      child.kill();
    };
    const timer = setTimeout(stop, timeout);
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
function containerArgs(
  name: string,
  image: string,
  network: string,
  mounts: string[],
  workdir: string,
  script: string,
  extra: string[] = [],
) {
  return [
    "create",
    "--pull",
    "never",
    "--name",
    name,
    "--network",
    network,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "10001:10001",
    "--pids-limit",
    "256",
    "--memory",
    "2g",
    "--cpus",
    "2",
    "--log-driver",
    "none",
    "--tmpfs",
    // `exec` is required: the venv lives on tmpfs and Python maps extension
    // modules with PROT_EXEC. Docker's --tmpfs default is noexec, which fails
    // with "failed to map segment from shared object".
    "/tmp:rw,exec,nosuid,nodev,size=1g,mode=1777",
    ...mounts.flatMap((m) => ["--mount", m]),
    "--workdir",
    workdir,
    "--env",
    "HOME=/tmp/home",
    "--env",
    "PYTHONNOUSERSITE=1",
    "--env",
    "PYTEST_DISABLE_PLUGIN_AUTOLOAD=1",
    "--env",
    "PIP_CONFIG_FILE=/dev/null",
    "--entrypoint",
    "python3",
    image,
    "-c",
    script,
    ...extra,
  ];
}
async function removeContainer(name: string) {
  await docker(["rm", "--force", name]);
  const state = await docker([
    "ps",
    "--all",
    "--filter",
    `name=^/${name}$`,
    "--format",
    "{{.Names}}",
  ]);
  if (state.code !== 0 || state.error || state.interrupted || state.output.trim())
    throw new Error("Python verification container cleanup could not be confirmed.");
}
function summary(checks: CodexAcceptanceCheck[]): CodexAcceptanceResult {
  return {
    status: checks.some((c) => c.status === "failed")
      ? "failed"
      : checks.some((c) => c.status === "blocked") || !checks.some((c) => c.status === "passed")
        ? "blocked"
        : "passed",
    checks,
  };
}

/** Disposable audited stage only. Online metadata/download never sees project files or secrets. */
export async function verifyCodexPythonBackend(
  stage: string,
  signal?: AbortSignal,
): Promise<CodexAcceptanceResult> {
  const checks: CodexAcceptanceCheck[] = [];
  let scratch: string | undefined;
  try {
    const stat = await fs.lstat(stage);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Invalid Python stage.");
    stage = await fs.realpath(stage);
    if (stage.includes(",")) throw new Error("Invalid Python mount path.");
    for (const root of ROOTS) {
      signal?.throwIfAborted();
      const location = path.join(stage, root);
      let directory;
      try {
        directory = await fs.lstat(location);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (directory.isSymbolicLink()) throw new Error("Python root symlinks refused.");
      if (!directory.isDirectory()) continue;
      const declared =
        (await plainFile(path.join(location, "requirements.txt"))) ||
        (await plainFile(path.join(location, "requirements-dev.txt")));
      if (!declared) {
        if (await plainFile(path.join(location, "pyproject.toml")))
          checks.push({
            name: `${root || "."}:python:dependencies`,
            status: "blocked",
            output:
              "pyproject.toml-only projects need a supported wheel requirements export; no generated build backend was executed online.",
          });
        continue;
      }
      const requirements = await collectCodexPythonRequirements(location);
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), "gs-python-verification-"));
      if (scratch.includes(",")) throw new Error("Invalid wheel mount path.");
      const input = path.join(scratch, "input"),
        wheels = path.join(scratch, "wheels");
      await fs.mkdir(input);
      await fs.mkdir(wheels);
      await fs.writeFile(path.join(input, "requirements.txt"), requirements.join("\n") + "\n", {
        mode: 0o600,
      });
      const downloadStarted = performance.now();
      await withDependencyNetwork(async ({ networkName, proxyUrl, imageId }) => {
        const name = `gs-python-fetch-${randomUUID()}`;
        try {
          await dependencyDocker(
            containerArgs(
              name,
              imageId,
              networkName,
              [`type=bind,src=${input},dst=/input,readonly`, `type=bind,src=${wheels},dst=/wheels`],
              "/tmp",
              DOWNLOAD_SCRIPT,
              [proxyUrl],
            ),
            undefined,
            30_000,
          );
          signal?.throwIfAborted();
          await dependencyDocker(["start", "--attach", name], signal, 600_000);
          const state = JSON.parse(
            await dependencyDocker(
              ["inspect", "--format", "{{json .State}}", name],
              undefined,
              30_000,
            ),
          );
          if (state.Running !== false || state.ExitCode !== 0)
            throw new Error("Python wheel download failed.");
        } finally {
          await removeContainer(name);
        }
      }, signal);
      checks.push({
        name: `${root || "."}:python:download`,
        status: "passed",
        command:
          "python -m pip download --only-binary=:all: --dest /wheels --proxy <restricted-proxy> --index-url https://pypi.org/simple -r /input/requirements.txt",
        durationMs: Math.round(performance.now() - downloadStarted),
        output:
          "Binary wheels downloaded through restricted dependency proxy; no project code executed online.",
      });
      const inspected = await docker(["image", "inspect", IMAGE, "--format", "{{json .}}"]);
      const image = JSON.parse(inspected.output);
      if (inspected.code !== 0 || image.Os !== "linux" || !/^sha256:[a-f0-9]{64}$/.test(image.Id))
        throw new Error("Python worker unavailable.");
      const name = `gs-python-verify-${randomUUID()}`;
      try {
        const created = await docker(
          containerArgs(
            name,
            image.Id,
            "none",
            [
              `type=bind,src=${stage},dst=/workspace`,
              `type=bind,src=${input},dst=/input,readonly`,
              `type=bind,src=${wheels},dst=/wheels,readonly`,
            ],
            `/workspace${root ? `/${root}` : ""}`,
            VERIFY_SCRIPT,
          ),
        );
        if (created.error || created.interrupted || created.code !== 0)
          throw new Error("Python container creation failed.");
        signal?.throwIfAborted();
        const run = await docker(["start", "--attach", name], signal, 300_000);
        const state = await docker(["inspect", "--format", "{{json .State}}", name]);
        const parsed = JSON.parse(state.output);
        if (
          run.error ||
          run.interrupted ||
          run.overflow ||
          state.code !== 0 ||
          parsed.Running !== false ||
          parsed.ExitCode !== 0
        )
          throw new Error(
            "Python verification interrupted, exceeded its output/time budget, or failed without complete evidence.",
          );
        const marker = run.output.lastIndexOf(RESULT_MARKER);
        if (marker < 0) throw new Error("Python verification produced no execution evidence.");
        const items: unknown = JSON.parse(
          run.output.slice(marker + RESULT_MARKER.length).split(/\r?\n/)[0],
        );
        if (!Array.isArray(items) || !items.length || items.length > 16)
          throw new Error("Invalid Python verification evidence.");
        for (const item of items) {
          if (
            !item ||
            typeof item.name !== "string" ||
            !/^python:(environment|dependencies|compile|tests|verification)$/.test(item.name) ||
            !["passed", "failed", "blocked"].includes(item.status) ||
            typeof item.output !== "string"
          )
            throw new Error("Invalid Python verification evidence.");
          checks.push({
            name: `${root || "."}:${item.name}`,
            status: item.status,
            exitCode: Number.isInteger(item.exitCode) ? item.exitCode : undefined,
            command:
              typeof item.command === "string"
                ? safeCodexText(item.command).slice(0, 2000)
                : undefined,
            durationMs:
              typeof item.durationMs === "number" &&
              Number.isFinite(item.durationMs) &&
              item.durationMs >= 0
                ? item.durationMs
                : undefined,
            output: safeCodexText(item.output).slice(0, 12000),
          });
        }
      } finally {
        await removeContainer(name);
      }
      await fs.rm(scratch, { recursive: true, force: true });
      scratch = undefined;
    }
  } catch (error) {
    checks.push({
      name: "python:verification",
      status: "blocked",
      output: signal?.aborted
        ? "Python verification cancelled; no host execution or model retry."
        : safeCodexText(String(error)).slice(0, 2000),
    });
  } finally {
    if (scratch) await fs.rm(scratch, { recursive: true, force: true });
  }
  return summary(checks);
}
