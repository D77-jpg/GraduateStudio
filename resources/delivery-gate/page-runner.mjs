// GraduateStudio 交付闸门 · 浏览器页面检查（平台自有）。
// 运行于 mcr.microsoft.com/playwright 容器，接入被测系统 compose 网络。
// 每个页面：注入登录态 → 打开路由 → 期望文本可见 → 无 console error / 页面异常 / API ≥400 → 1440 宽截图。
// 截图即论文可用的系统运行截图（/out/shots/*.png）。
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.GS_PLAYWRIGHT_MODULE || "/tmp/pw/node_modules/playwright");
const contract = JSON.parse(fs.readFileSync("/spec/contract.json", "utf8"));
const scope = JSON.parse(fs.readFileSync("/spec/smoke.json", "utf8"));
const saved = fs.existsSync("/out/saved.json") ? JSON.parse(fs.readFileSync("/out/saved.json", "utf8")) : {};
const front = `http://${contract.frontend.service}:${contract.frontend.port}`;
const backend = `http://${contract.backend.service}:${contract.backend.port}`;
const auth = contract.auth;
const emit = (r) => process.stdout.write(`GS_RESULT ${JSON.stringify(r)}\n`);
const tokens = new Map();
fs.mkdirSync("/out/shots", { recursive: true });

const get = (v, dotted) =>
  String(dotted).split(".").filter(Boolean).reduce((c, k) => (c == null ? undefined : Array.isArray(c) && /^\d+$/.test(k) ? c[Number(k)] : c[k]), v);
const substitute = (s) => s.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (m, n) => (n in saved ? String(saved[n]) : m));

async function tokenFor(role) {
  if (!role) return undefined;
  if (tokens.has(role)) return tokens.get(role);
  const account = (contract.accounts ?? []).find((a) => a.role === role);
  if (!auth || !account) throw new Error(`无法以角色 ${role} 登录：契约缺少 auth 或账号`);
  const r = await fetch(backend + auth.loginPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [auth.usernameField ?? "username"]: account.username, [auth.passwordField ?? "password"]: account.password }),
    signal: AbortSignal.timeout(15000),
  });
  const json = await r.json().catch(() => undefined);
  const token = get(json, auth.tokenJsonPath);
  if (!token) throw new Error(`角色 ${role} 登录失败：HTTP ${r.status}`);
  tokens.set(role, token);
  return token;
}

const browser = await chromium.launch();
try {
  for (const { moduleId, smoke } of scope) {
    for (let index = 0; index < smoke.length; index++) {
      const step = smoke[index];
      if (step.kind !== "page") continue;
      const id = `page:${moduleId}:${index}`;
      const label = step.name ?? step.route;
      const problems = [];
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
      try {
        const token = await tokenFor(step.as);
        if (token && auth?.frontendStorage)
          await context.addInitScript(
            ([type, key, value]) => window[type].setItem(key, value),
            [auth.frontendStorage.type, auth.frontendStorage.key, token],
          );
        const page = await context.newPage();
        page.on("console", (m) => m.type() === "error" && problems.push(`console.error：${m.text().slice(0, 300)}`));
        page.on("pageerror", (e) => problems.push(`页面异常：${String(e.message).slice(0, 300)}`));
        page.on("response", (r) => {
          if (r.url().includes("/api/") && r.status() >= 400) problems.push(`接口 ${r.request().method()} ${new URL(r.url()).pathname} → ${r.status()}`);
        });
        await page.goto(front + substitute(step.route), { waitUntil: "networkidle", timeout: 30000 });
        for (const text of step.expectText) {
          const visible = await page
            .getByText(substitute(text), { exact: false })
            .first()
            .waitFor({ state: "visible", timeout: 10000 })
            .then(() => true, () => false);
          if (!visible) problems.push(`未看到文本「${text}」`);
        }
        const bodyText = (await page.locator("body").innerText().catch(() => "")).trim();
        if (bodyText.length < 10) problems.push("页面几乎为空白（正文少于 10 个字符）");
        const shot = `/out/shots/${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.png`;
        await page.screenshot({ path: shot, fullPage: true });
        emit({ id, ok: problems.length === 0, label, detail: problems.length ? problems.join("\n") : `页面正常：${step.route}`, screenshot: shot });
      } catch (error) {
        emit({ id, ok: false, label, detail: [...problems, String(error?.message ?? error)].join("\n") });
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}
process.stdout.write("GS_DONE\n");
