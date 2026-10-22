// GraduateStudio 交付闸门 · HTTP 冒烟执行器（平台自有，只读挂载进探针容器，不在生成项目内）。
// 运行于 node:22 容器，接入被测系统的 compose 网络，直接按服务名访问后端。
// 输入：/spec/contract.json、/spec/smoke.json（[{moduleId, smoke: SmokeSpec[]}]）
// 输出：每项结果一行 `GS_RESULT {...}`；保存变量写入 /out/saved.json。
import fs from "node:fs";

const MODE = process.env.GS_MODE === "recheck" ? "recheck" : "run";
const contract = JSON.parse(fs.readFileSync("/spec/contract.json", "utf8"));
const scope = JSON.parse(fs.readFileSync("/spec/smoke.json", "utf8"));
const base = `http://${contract.backend.service}:${contract.backend.port}`;
const auth = contract.auth;
const saved = MODE === "recheck" && fs.existsSync("/out/saved.json")
  ? JSON.parse(fs.readFileSync("/out/saved.json", "utf8"))
  : { rand: Math.random().toString(36).slice(2, 8) };
const tokens = new Map();

const emit = (result) => process.stdout.write(`GS_RESULT ${JSON.stringify(result)}\n`);
const clip = (text, n = 1500) => (text.length > n ? text.slice(0, n) + "…(已截断)" : text);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(value, dotted) {
  let current = value;
  for (const key of String(dotted).split(".").filter(Boolean)) {
    if (current === null || current === undefined) return undefined;
    current = Array.isArray(current) && /^\d+$/.test(key) ? current[Number(key)] : current[key];
  }
  return current;
}
function substitute(value) {
  if (typeof value === "string") {
    const whole = /^\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}$/.exec(value);
    if (whole && whole[1] in saved) return saved[whole[1]];
    return value.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (m, name) =>
      name in saved ? String(saved[name]) : m,
    );
  }
  if (Array.isArray(value)) return value.map(substitute);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v)]));
  return value;
}
async function request(method, path, { body, token } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token && auth) headers[auth.header || "Authorization"] = `${auth.scheme ?? "Bearer"} ${token}`.trim();
  const response = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
    redirect: "manual",
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json };
}
async function waitHealthy() {
  const deadline = Date.now() + 180_000;
  let last = "未响应";
  while (Date.now() < deadline) {
    try {
      const r = await request("GET", contract.backend.health);
      if (r.status >= 200 && r.status < 300) return { ok: true, detail: `HTTP ${r.status} ${clip(r.text, 300)}` };
      last = `HTTP ${r.status} ${clip(r.text, 300)}`;
    } catch (error) {
      last = String(error?.cause?.code ?? error?.message ?? error);
    }
    await sleep(2000);
  }
  return { ok: false, detail: `180 秒内健康检查未通过：${last}` };
}
async function tokenFor(role) {
  if (!role) return undefined;
  if (tokens.has(role)) return tokens.get(role);
  if (!auth) throw new Error(`契约未定义 auth，无法以角色 ${role} 登录`);
  const account = (contract.accounts ?? []).find((a) => a.role === role);
  if (!account) throw new Error(`契约 accounts 中没有角色 ${role}`);
  const r = await request("POST", auth.loginPath, {
    body: { [auth.usernameField ?? "username"]: account.username, [auth.passwordField ?? "password"]: account.password },
  });
  const token = get(r.json, auth.tokenJsonPath);
  if (r.status >= 300 || !token)
    throw new Error(`角色 ${role} 登录失败：HTTP ${r.status}，${clip(r.text, 500)}（tokenJsonPath=${auth.tokenJsonPath}）`);
  tokens.set(role, token);
  return token;
}
function checkJson(expect, json) {
  const problems = [];
  for (const [dotted, wanted] of Object.entries(expect ?? {})) {
    const actual = get(json, dotted);
    if (wanted === "*") {
      if (actual === undefined || actual === null || actual === "") problems.push(`${dotted} 应存在且非空，实际为 ${JSON.stringify(actual)}`);
      continue;
    }
    const expected = substitute(wanted);
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      problems.push(`${dotted} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
  return problems;
}
const referencesSaved = (step) =>
  [...JSON.stringify([step.path, step.body ?? null]).matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g)].some(
    (m) => m[1] !== "rand",
  );

const health = await waitHealthy();
emit({ id: MODE === "recheck" ? "persist:health" : "runtime:health:backend", ok: health.ok, detail: health.detail });
if (!health.ok) process.exit(0);

for (const { moduleId, smoke } of scope) {
  for (let index = 0; index < smoke.length; index++) {
    const step = smoke[index];
    if (step.kind !== "http") continue;
    if (MODE === "recheck" && !(step.method === "GET" && referencesSaved(step))) continue;
    const id = `${MODE === "recheck" ? "persist" : "smoke"}:${moduleId}:${index}`;
    const label = step.name ?? `${step.method} ${step.path}`;
    try {
      const token = await tokenFor(step.as);
      const path = substitute(step.path);
      const r = await request(step.method, path, { body: substitute(step.body), token });
      const problems = [];
      if (r.status !== step.expectStatus) problems.push(`状态码期望 ${step.expectStatus}，实际 ${r.status}`);
      problems.push(...checkJson(step.expectJson, r.json));
      if (!problems.length && MODE === "run")
        for (const [name, dotted] of Object.entries(step.saveAs ?? {})) {
          const value = get(r.json, dotted);
          if (value === undefined || value === null) problems.push(`saveAs ${name} ← ${dotted} 在响应中不存在`);
          else saved[name] = value;
        }
      emit({
        id,
        ok: problems.length === 0,
        label,
        detail: problems.length
          ? `${step.method} ${path} → ${problems.join("；")}\n响应：${clip(r.text)}`
          : `${step.method} ${path} → HTTP ${r.status}`,
      });
    } catch (error) {
      emit({ id, ok: false, label, detail: String(error?.message ?? error) });
    }
  }
}
if (MODE === "run") fs.writeFileSync("/out/saved.json", JSON.stringify(saved));
process.stdout.write("GS_DONE\n");
