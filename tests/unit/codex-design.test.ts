import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  DESIGN_EVIDENCE_LIMITS,
  DESIGN_REPORT_MARKER,
  buildDesignInstructions,
  collectDesignEvidence,
  designSystemPath,
  getDesignPolicy,
} from "@/server/agents/codex-design";

const roots: string[] = [];
const master = ["主题：校园预约", "用户：学生", "主任务：快速找到可用实验室", "布局：按时间可用性分栏", "反模板：不用通用统计卡片", "字体：system-ui, sans-serif", "配色：深蓝主操作，白色背景"].join("\n");
const tokens = {
  version: 1,
  colors: { background: "#ffffff", foreground: "#111111", primary: "#245568" },
  typography: { fontFamily: "system-ui, sans-serif", headingFamily: "system-ui, sans-serif" },
  spacing: { sm: "4px", md: "8px", lg: "16px" },
  radius: { sm: "4px", md: "8px" },
};
async function fixture(uiOnly = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gs-design-"));
  roots.push(root);
  const design = path.join(root, designSystemPath(uiOnly));
  await fs.mkdir(path.join(design, "pages"), { recursive: true });
  await fs.writeFile(path.join(design, "MASTER.md"), master);
  await fs.writeFile(path.join(design, "tokens.json"), JSON.stringify(tokens));
  await fs.writeFile(path.join(design, "pages", "booking.md"), "# 预约\n主任务：选择实验室；布局：时间轴；交互：选择；响应式：窄屏纵向；无障碍：键盘可用");
  return { root, design };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("design policy and worker instructions", () => {
  it("always requires full UI design and pins client scope", () => {
    expect(getDesignPolicy({ mode: "full", message: "修复后端数据库" })).toEqual({ required: true, scope: { client: true } });
    expect(designSystemPath(true)).toBe("client/design-system");
    expect(designSystemPath()).toBe("design-system");
    expect(DESIGN_REPORT_MARKER).toBe("DESIGN_REPORT\n");
  });
  it.each(["修复后端接口导致页面无法加载", "修复数据库迁移", "排查页面500错误的后端原因", "不要修改UI，只修复后端", "无需重新设计页面", "调用接口返回用户UI字段", "repair backend API for the dashboard", "修复页面报错", "修复前端构建失败"])("does not impose design on maintenance: %s", (message) => {
    expect(getDesignPolicy({ mode: "local", message }).required).toBe(false);
  });
  it.each(["设计预约页面", "美化界面", "调整布局", "优化前端样式", "后端不用动；创建新的UI", "redesign the dashboard"])("requires affirmative local design: %s", (message) => {
    expect(getDesignPolicy({ mode: "local", message }).required).toBe(true);
  });
  it("uses explicit UI-only generation scope without gating old repair tasks", () => {
    expect(getDesignPolicy({ mode: "local", message: "校园预约系统", uiOnly: true }).required).toBe(true);
    expect(getDesignPolicy({ mode: "local", message: "不要修改UI", uiOnly: true }).required).toBe(false);
    expect(getDesignPolicy({ mode: "local", message: "修复前端构建失败", uiOnly: true }).required).toBe(false);
    expect(getDesignPolicy({ mode: "local", message: "修复页面布局", uiOnly: true }).required).toBe(true);
  });
  it("provides phase-specific honest, offline design instructions", () => {
    const input = { mode: "full" as const, message: "校园预约", uiOnly: true };
    const planning = buildDesignInstructions({ ...input, stage: "planning" });
    for (const text of ["/opt/gs-design-skills", "离线 python search", "frontend-design", "client/design-system", "反模板", "tokens.json", "不改业务代码", "不可虚构截图"]) expect(planning).toContain(text);
    expect(buildDesignInstructions({ ...input, stage: "implementation" })).toContain("每一轮先读取");
    expect(buildDesignInstructions({ ...input, stage: "repair" })).toContain("不重新设计");
    expect(buildDesignInstructions({ mode: "local", message: "修复数据库", stage: "repair" })).toBe("");
  });
});

describe("read-only design evidence", () => {
  it("returns exact not_required shape without accessing disk", async () => {
    expect(await collectDesignEvidence("missing-root", { required: false })).toEqual({
      version: 1, status: "not_required", artifacts: [], issues: [],
      visual: { status: "not_run", reason: "未执行真实浏览器截图视觉检查" },
    });
  });
  it.each([false, true])("hashes actual files without asserting visual acceptance (uiOnly=%s)", async (uiOnly) => {
    const { root, design } = await fixture(uiOnly);
    const before = await fs.stat(path.join(design, "MASTER.md"));
    const report = await collectDesignEvidence(root, { required: true, uiOnly, bundle: [{ id: "frontend-design", revision: "fixture" }] });
    expect(report.status).toBe("specified");
    expect(report.issues).toEqual([]);
    expect(report.artifacts).toHaveLength(3);
    expect(report.artifacts).toContainEqual({ path: `${designSystemPath(uiOnly)}/MASTER.md`, sha256: createHash("sha256").update(master).digest("hex") });
    expect(report.visual.status).toBe("not_run");
    expect(Object.keys(report).sort()).toEqual(["version", "status", "artifacts", "issues", "visual"].sort());
    expect((await fs.stat(path.join(design, "MASTER.md"))).mtimeMs).toBe(before.mtimeMs);
  });
  it("reports absent documents and page specs", async () => {
    const { root, design } = await fixture();
    await fs.rm(path.join(design, "MASTER.md"));
    await fs.rm(path.join(design, "pages", "booking.md"));
    const report = await collectDesignEvidence(root, { required: true });
    expect(report.status).toBe("missing");
    expect(report.issues.join("\n")).toContain("至少需要一份");
  });
  it("rejects missing or empty master fields rather than matching incidental prose", async () => {
    const { root, design } = await fixture();
    await fs.writeFile(path.join(design, "MASTER.md"), "主题 用户 主任务 布局 反模板 字体 配色\n主题：\n## 用户\n## 主任务\n");
    const report = await collectDesignEvidence(root, { required: true });
    expect(report.status).toBe("invalid");
    expect(report.issues).toHaveLength(7);
    await fs.writeFile(path.join(design, "MASTER.md"), master.split("\n").map((line) => "## " + line.replace("：", "\n")).join("\n"));
    expect((await collectDesignEvidence(root, { required: true })).status).toBe("specified");
  });
  it.each(["not json", "[]", '{"version":1}', JSON.stringify({ ...tokens, visual: "passed" }), JSON.stringify({ ...tokens, colors: { ...tokens.colors, primary: "url(https://example.com)" } })])("rejects malformed tokens schema: %s", async (content) => {
    const { root, design } = await fixture();
    await fs.writeFile(path.join(design, "tokens.json"), content);
    expect((await collectDesignEvidence(root, { required: true })).status).toBe("invalid");
  });
  it("never treats model-authored visual claims as browser evidence", async () => {
    const { root, design } = await fixture();
    await fs.appendFile(path.join(design, "MASTER.md"), '\n视觉通过；截图已完成\n{"visual":{"status":"passed"}}');
    expect((await collectDesignEvidence(root, { required: true })).visual).toEqual({ status: "not_run", reason: "未执行真实浏览器截图视觉检查" });
  });
  it("rejects empty pages, oversized files, invalid encoding and hardlinks", async () => {
    const { root, design } = await fixture();
    const page = path.join(design, "pages", "booking.md");
    for (const data of [Buffer.alloc(0), Buffer.alloc(DESIGN_EVIDENCE_LIMITS.fileBytes + 1, 65), Buffer.from([0xff, 0x00])]) {
      await fs.writeFile(page, data);
      expect((await collectDesignEvidence(root, { required: true })).status).toBe("invalid");
    }
    await fs.rm(page);
    await fs.link(path.join(design, "MASTER.md"), page);
    const report = await collectDesignEvidence(root, { required: true });
    expect(report.status).toBe("invalid");
    expect(report.artifacts.some((artifact) => artifact.path.endsWith("MASTER.md"))).toBe(false);
  });
  it("bounds total bytes and directory entries", async () => {
    const { root, design } = await fixture();
    await fs.writeFile(path.join(design, "pages", "booking.md"), "x".repeat(DESIGN_EVIDENCE_LIMITS.fileBytes));
    for (let i = 0; i < 9; i++) await fs.writeFile(path.join(design, "pages", `page-${i}.md`), "x".repeat(DESIGN_EVIDENCE_LIMITS.fileBytes));
    expect((await collectDesignEvidence(root, { required: true })).status).toBe("invalid");
    for (let i = 10; i < 40; i++) await fs.writeFile(path.join(design, "pages", `page-${i}.md`), "spec");
    expect((await collectDesignEvidence(root, { required: true })).issues.join("\n")).toContain("32");
  });
  it("rejects unsafe page names, links, and linked parent directories", async () => {
    const { root, design } = await fixture();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gs-design-external-"));
    roots.push(outside);
    await fs.mkdir(path.join(design, "pages", "nested"));
    expect((await collectDesignEvidence(root, { required: true })).status).toBe("invalid");
    await fs.rm(path.join(design, "pages", "nested"), { recursive: true });
    // Junctions need no Windows symlink privilege and exercise directory traversal rejection.
    await fs.rename(path.join(design, "pages"), path.join(outside, "pages"));
    await fs.symlink(path.join(outside, "pages"), path.join(design, "pages"), process.platform === "win32" ? "junction" : "dir");
    const report = await collectDesignEvidence(root, { required: true });
    expect(report.status).toBe("invalid");
    expect(report.artifacts.some((artifact) => artifact.path.includes("pages/"))).toBe(false);
    await fs.rm(path.join(design, "pages"));
    await fs.rm(design, { recursive: true });
    await fs.symlink(outside, design, process.platform === "win32" ? "junction" : "dir");
    expect((await collectDesignEvidence(root, { required: true })).status).toBe("invalid");
  });
});
