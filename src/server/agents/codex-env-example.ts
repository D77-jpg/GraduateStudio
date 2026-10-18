import fs from "node:fs/promises";
import path from "node:path";

export const ENV_EXAMPLE_LIMIT = 16 * 1024;

// Deliberately narrow: unknown values, comments, interpolation and shell syntax
// are rejected, not heuristically scrubbed. Never include rejected bytes in errors.
function placeholder(value: string): boolean {
  return /^(?:|placeholder|change-me|changeme|replace-me|your-(?:key|token|secret|password|username|database)|<(?:key|token|secret|password|username|database)>|please-change-(?:me|secret|key|token|password|database|admin|model)(?:-(?:secret|key|token|password))?)$/i.test(
    value,
  );
}
function localUrl(value: string): boolean {
  // Reject URL normalization tricks and encoded material before parsing.
  if (/[\s\\%]/.test(value) || /\/(?:\.{1,2})(?:\/|$)/.test(value)) return false;
  try {
    const url = new URL(value);
    if (
      ![
        "http:",
        "https:",
        "redis:",
        "mysql:",
        "mysql+pymysql:",
        "postgresql:",
        "postgres:",
      ].includes(url.protocol)
    )
      return false;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return false;
    if (url.hash || (url.search && url.search !== "?charset=utf8mb4")) return false;
    if (url.username && !placeholder(decodeURIComponent(url.username))) return false;
    if (url.password && !placeholder(decodeURIComponent(url.password))) return false;
    return /^\/(?:api|example|placeholder|[0-9])?$/.test(url.pathname || "/");
  } catch {
    return false;
  }
}
export function isSafeEnvExample(data: Buffer): boolean {
  if (data.length > ENV_EXAMPLE_LIMIT || data.includes(0)) return false;
  const text = data.toString("utf8");
  if (!Buffer.from(text).equals(data) || /[^\P{C}\n\r\t]/u.test(text)) return false;
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // Free-form comments can contain secrets too. Support only this fixed heading.
    if (line === "# Example environment configuration") continue;
    const match = /^([A-Z][A-Z0-9_]{0,63})=([^\r\n]{0,512})$/.exec(line);
    if (!match || seen.has(match[1])) return false;
    const [, key, value] = match;
    seen.add(key);
    if (placeholder(value)) continue;
    if (/(?:KEY|PASS|TOKEN|SECRET|CREDENTIAL|AUTH|COOKIE|CERT)/i.test(key)) return false;
    if (/^(?:NODE_ENV|APP_ENV)$/.test(key) && /^(?:production|development|test)$/.test(value))
      continue;
    if (/^(?:DEBUG|TESTING)$/.test(key) && /^(?:true|false|0|1)$/.test(value)) continue;
    if (
      /^(?:PORT|(?:APP|API|SERVER|MYSQL|REDIS|DATABASE)_PORT)$/.test(key) &&
      /^\d{1,5}$/.test(value) &&
      +value > 0 &&
      +value <= 65535
    )
      continue;
    if (
      /^(?:HOST|(?:APP|API|SERVER|MYSQL|REDIS|DATABASE)_HOST)$/.test(key) &&
      /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(value)
    )
      continue;
    if (
      /^(?:VITE_API_TIMEOUT_MS|API_TIMEOUT_MS)$/.test(key) &&
      /^(?:1000|5000|10000|30000|60000)$/.test(value)
    )
      continue;
    if (/^(?:VITE_API_BASE_URL|API_BASE_URL)$/.test(key) && value === "/api") continue;
    if (
      /^(?:UPLOAD_DIR|EXPORT_DIR)$/.test(key) &&
      /^(?:\/app\/)?var\/(?:uploads|exports)$/.test(value)
    )
      continue;
    if (
      /^(?:DATABASE_URL|REDIS_URL|API_URL|VITE_API_BASE_URL|CORS_ORIGINS)$/.test(key) &&
      localUrl(value)
    )
      continue;
    return false;
  }
  return true;
}

/** Only exact .env.example regular files; bounded reads even if a file grows. */
export async function readSafeEnvExample(file: string): Promise<Buffer | null> {
  if (path.basename(file) !== ".env.example") return null;
  const initial = await fs.lstat(file);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size > ENV_EXAMPLE_LIMIT)
    return null;
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > ENV_EXAMPLE_LIMIT ||
      stat.dev !== initial.dev ||
      stat.ino !== initial.ino
    )
      return null;
    const buffer = Buffer.alloc(ENV_EXAMPLE_LIMIT + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) return null;
    const data = buffer.subarray(0, bytesRead);
    return isSafeEnvExample(data) ? data : null;
  } finally {
    await handle.close();
  }
}
