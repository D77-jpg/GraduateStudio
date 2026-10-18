import fs from "node:fs";
import path from "node:path";

export interface BackendPlan {
  directory: string;
  script: "start" | "dev";
  env: NodeJS.ProcessEnv;
}

/** Load project configuration as data; never execute shell substitutions or read acceptance env. */
export function readRuntimeEnv(directory: string, names = [".env"]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of names) {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) continue;
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 65536)
      throw new Error(`Runtime configuration ${name} must be a regular file at most 64KiB.`);
    for (const raw of fs
      .readFileSync(file, "utf8")
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) throw new Error(`Invalid runtime configuration in ${name}.`);
      let value = match[2];
      if (value.startsWith('"') || value.startsWith("'")) {
        const quote = value[0];
        const end = value.lastIndexOf(quote);
        if (end === 0 || !/^\s*(?:#.*)?$/.test(value.slice(end + 1)))
          throw new Error(`Invalid quoted runtime configuration in ${name}.`);
        value = value.slice(1, end);
        if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
      } else value = value.replace(/\s+#.*$/, "").trim();
      // A project may not inject executable loader options or acceptance-test switches.
      if (
        !/^(?:NODE_OPTIONS|NODE_PATH|PATH|PATHEXT|COMSPEC|LD_PRELOAD|DYLD_|TEST_DB_)/i.test(
          match[1],
        )
      )
        result[match[1]] = value;
    }
  }
  return result;
}

export function backendEnvironment(projectDir: string, inherited = process.env): NodeJS.ProcessEnv {
  const env = { ...inherited };
  // Platform DB credentials and test connections must never become preview credentials.
  for (const key of Object.keys(env)) {
    if (/^(?:DB_|TEST_DB_|JWT_|DATABASE_URL$|DIRECT_URL$)/.test(key)) delete env[key];
  }
  return {
    ...env,
    ...readRuntimeEnv(projectDir),
    ...readRuntimeEnv(path.join(projectDir, "backend")),
    NODE_ENV: "development",
  };
}

export function detectBackend(projectDir: string): BackendPlan | null {
  const directory = path.join(projectDir, "backend");
  const file = path.join(directory, "package.json");
  if (!fs.existsSync(file)) return null;
  const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as {
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  if (!pkg.dependencies?.express) return null;
  const script = pkg.scripts?.start ? "start" : pkg.scripts?.dev ? "dev" : null;
  if (!script)
    throw new Error("Express backend needs a start or dev script in backend/package.json.");
  return { directory, script, env: backendEnvironment(projectDir) };
}

export function externalApiTarget(projectDir: string): string | null {
  const env = {
    ...readRuntimeEnv(projectDir),
    ...readRuntimeEnv(path.join(projectDir, "client"), [".env", ".env.local"]),
  };
  const raw = env.VITE_DEV_API_TARGET?.trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "VITE_DEV_API_TARGET must be an HTTP(S) URL without credentials, query or fragment.",
    );
  return url.href.replace(/\/$/, "");
}

/** HTTP readiness, not a TCP-only check. Health does not certify database connectivity. */
export async function waitForRuntimeHttp(
  url: string,
  timeoutMs = 45000,
  cancelled: () => boolean = () => false,
  requireJson = false,
): Promise<{ ready: boolean; error: string | null }> {
  const deadline = Date.now() + timeoutMs;
  let error = "HTTP readiness timed out";
  do {
    if (cancelled()) return { ready: false, error: "Startup cancelled or process exited" };
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(1500, deadline - Date.now()))),
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        error = `HTTP ${response.status} at readiness endpoint`;
      } else if (requireJson) {
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Empty health response");
        let size = 0;
        const chunks: Uint8Array[] = [];
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 16384) throw new Error("Health response exceeds 16KiB");
            chunks.push(value);
          }
        } finally {
          await reader.cancel();
        }
        const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (data?.status === "ok" || data?.data?.status === "ok" || data?.status === "healthy")
          return { ready: true, error: null };
        error = "Health response does not report ok/healthy";
      } else {
        await response.body?.cancel();
        return { ready: true, error: null };
      }
    } catch {
      error = "Readiness endpoint unavailable or invalid response";
    }
    if (Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
  } while (Date.now() < deadline);
  return { ready: false, error };
}
