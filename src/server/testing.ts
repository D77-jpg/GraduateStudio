import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { generateObjectCompat } from "@/server/ai/compat";
import { db } from "@/server/db";
import type { TestRun, TestResult } from "@prisma/client";
import { AiNotConfiguredError } from "@/server/ai/provider";
import { buildProjectRequirementText } from "@/server/agents/context";
import { getArchitecture } from "@/server/architecture";
import {
  generatedTestSchema,
  failureAnalysisOutputSchema,
  testFixOutputSchema,
  type TestKind,
  type TestRunDto,
  testRunDtoSchema,
  type TestResultStatus,
} from "@/lib/testing";
import { resolveProjectDir } from "@/server/workspace/paths";
import { logActivity } from "@/server/activity";

/**
 * Phase 7:测试中心服务。
 * AI 生成(Vitest)→ 真实执行(vitest run --reporter=json)→ TestRun/TestResult 落库 →
 * AI 失败分析 → AI Fix(改码/改测试,留痕 ChangeSet)→ 回归重跑。
 */

const execFileAsync = promisify(execFile);
const clip = (s: string, n = 8000) => (s.length > n ? `${s.slice(0, n)}\n…(截断)` : s);

export class TestingError extends Error {
  code: string;
  constructor(message: string, code = "testing_error") {
    super(message);
    this.name = "TestingError";
    this.code = code;
  }
}

async function assertProjectOwner(projectId: string, userId: string): Promise<void> {
  const p = await db.project.findFirst({ where: { id: projectId, userId }, select: { id: true } });
  if (!p) throw new TestingError("项目不存在或无权访问", "not_found");
}

function clientDirOf(projectId: string): string {
  return path.join(resolveProjectDir(projectId), "client");
}

/** 确保 vitest 可用(缺失自动安装到 client devDependencies)。 */
async function ensureVitest(projectId: string): Promise<void> {
  const clientDir = clientDirOf(projectId);
  if (!fs.existsSync(path.join(clientDir, "package.json"))) {
    throw new TestingError("未找到 client/package.json,请先在工作区生成前端项目", "no_project");
  }

  // 1. 依赖不完整时先做完整安装(含 devDependencies:vite / vitest)
  if (!fs.existsSync(path.join(clientDir, "node_modules", "vite"))) {
    await execFileAsync("npm", ["install", "--no-audit", "--no-fund", "--loglevel", "error"], {
      cwd: clientDir,
      timeout: 600_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      shell: process.platform === "win32",
    }).catch((e) => {
      const err = e as { stderr?: string; message?: string };
      throw new TestingError(
        `依赖安装失败:${clip(err.stderr || err.message || "", 300)}`,
        "install_failed",
      );
    });
  }

  // 2. 确保测试生态完整:npm 偶发"半装"(exit 0 但部分包缺失)会导致
  //    vitest 配置加载失败,这里把 vite/@vitejs/plugin-vue 一并校验
  const testEnvReady =
    fs.existsSync(path.join(clientDir, "node_modules", "vite", "package.json")) &&
    fs.existsSync(path.join(clientDir, "node_modules", "@vitejs", "plugin-vue", "package.json")) &&
    fs.existsSync(path.join(clientDir, "node_modules", "vitest", "package.json")) &&
    fs.existsSync(path.join(clientDir, "node_modules", "jsdom", "package.json")) &&
    fs.existsSync(path.join(clientDir, "node_modules", "@vue", "test-utils", "package.json"));
  if (!testEnvReady) {
    await execFileAsync("npm", ["install", "--no-audit", "--no-fund", "--loglevel", "error"], {
      cwd: clientDir,
      timeout: 600_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      shell: process.platform === "win32",
    }).catch((e) => {
      const err = e as { stderr?: string; message?: string };
      throw new TestingError(
        `测试依赖安装失败:${clip(err.stderr || err.message || "", 300)}`,
        "install_failed",
      );
    });
  }

  // vitest 配置:jsdom 环境(组件挂载需要 DOM);仅首次创建
  const vitestConfig = path.join(clientDir, "vitest.config.js");
  if (!fs.existsSync(vitestConfig)) {
    fs.writeFileSync(
      vitestConfig,
      [
        "import { defineConfig } from 'vitest/config';",
        "import vue from '@vitejs/plugin-vue';",
        "",
        "export default defineConfig({",
        "  plugins: [vue()],",
        "  test: { environment: 'jsdom' },",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );
  }
}

// ===== AI 生成 =====

export async function generateTests(
  projectId: string,
  userId: string,
  kind: TestKind,
): Promise<{ notes: string; files: Array<{ path: string; content: string }>; installed: boolean }> {
  await assertProjectOwner(projectId, userId);
  await ensureVitest(projectId);

  const { projectText, requirementText } = await buildProjectRequirementText(projectId, userId);
  const architecture = await getArchitecture(projectId, userId);
  const archText = architecture
    ? `架构:${architecture.summary}\n模块:${architecture.modules.map((m) => m.name).join("、")}\nAPI:${architecture.apis
        .slice(0, 12)
        .map((a) => `${a.method} ${a.path}`)
        .join("; ")}`
    : "(无架构设计)";

  // 现有源文件清单(供 AI 选择测试目标)
  const srcDir = path.join(clientDirOf(projectId), "src");
  const srcFiles: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) walk(full);
      else if (/\.(js|mjs|vue)$/.test(f.name))
        srcFiles.push(path.relative(clientDirOf(projectId), full).replaceAll("\\", "/"));
    }
  };
  walk(srcDir);

  // 提供关键源文件内容(AI 需要看到实现才能写出可通过的测试)
  const srcContents: string[] = [];
  let remaining = 14_000;
  for (const f of srcFiles) {
    if (remaining <= 0) break;
    const content = fs.readFileSync(path.join(clientDirOf(projectId), f), "utf8");
    const clipped = content.slice(0, Math.min(4_000, remaining));
    remaining -= clipped.length;
    srcContents.push(
      `--- ${f} ---\n${clipped}${clipped.length < content.length ? "\n…(截断)" : ""}`,
    );
  }

  const kindHint: Record<TestKind, string> = {
    unit: "单元测试:针对 src/ 下的纯函数与组件逻辑(用 Vitest,可 mock)",
    api: "API/接口测试:针对前端 api/ 封装层的请求构造与响应处理(mock fetch)",
    e2e: "端到端流程测试:以用户视角用 Vitest 编排关键业务流程断言(mock 外部依赖)",
    permission: "权限测试:验证不同角色的权限判断逻辑",
  };

  const result = await generateObjectCompat({
    system:
      "你是测试工程师,为学生的 Vue 3 毕业设计项目编写 Vitest 测试。规则:1) 测试文件放 client/tests/ 目录,ESM,使用 Vitest 的 describe/it/expect;2) 纯逻辑测试优先;涉及 DOM/组件时只测可脱离浏览器的逻辑;外部请求一律 vi.mock;3) 每个文件 3-8 个用例,断言具体;4) 只输出符合 JSON Schema 的内容,中文说明。",
    prompt: `请为以下项目生成${kindHint[kind]}。

${projectText}

## 需求摘要
${requirementText.slice(0, 3000)}

## 架构
${archText}

## 现有源文件
${srcFiles.slice(0, 30).join("\n") || "(无)"}

## 源文件内容(基于这些真实实现编写测试,导出名/行为必须与之一致)
${srcContents.join("\n\n") || "(空)"}

要求:测试文件放 client/tests/ 下(文件名 *.test.js);生成的测试必须能在 Node + Vitest 环境真实通过(不依赖浏览器与后端服务;如需网络请求一律 vi.mock)。
注意:测试文件位于 client/tests/,导入被测代码的相对路径是 ../src/...(一层),不要写 ../../src/。`,
    schema: generatedTestSchema,
    schemaName: "GeneratedTests",
    maxOutputTokens: 12_000,
    signal: AbortSignal.timeout(280_000),
  }).catch((error) => {
    if (error instanceof AiNotConfiguredError) throw error;
    throw new TestingError(
      `测试生成失败:${error instanceof Error ? error.message : String(error)}`,
      "ai_failed",
    );
  });

  // 写盘 + 留痕
  const changeRows = result.files.map((f) => {
    const abs = path.join(
      clientDirOf(projectId),
      f.path.replaceAll("\\", "/").replace(/^client\//, ""),
    );
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const before = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
    fs.writeFileSync(abs, f.content, "utf8");
    return {
      path: path.relative(resolveProjectDir(projectId), abs).replaceAll("\\", "/"),
      action: before === null ? "create" : "modify",
      beforeContent: before,
      afterContent: f.content,
    };
  });

  await db.changeSet.create({
    data: {
      projectId,
      title: `AI 生成${kind === "unit" ? "单元" : kind === "api" ? "API" : kind === "e2e" ? "E2E" : "权限"}测试`,
      summary: result.notes,
      source: "ai",
      status: "accepted",
      appliedAt: new Date(),
      changes: { create: changeRows },
    },
  });
  await logActivity(projectId, "ai", `AI 生成测试(${result.files.length} 个文件)`, result.notes);

  return { notes: result.notes, files: result.files, installed: true };
}

// ===== 执行 =====

function parseVitestJson(raw: string): {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  results: Array<{
    name: string;
    suite: string;
    status: TestResultStatus;
    message: string;
    durationMs: number;
  }>;
} {
  // 定位 vitest JSON:{"numTotalTests":... 的起始行,避免把告警里的 { 当 JSON 开头
  const keyIndex = raw.indexOf('"numTotalTests"');
  if (keyIndex < 0) throw new Error("输出中未找到 vitest JSON 结果");
  const start = raw.lastIndexOf("{", keyIndex);
  const jsonText = start >= 0 ? raw.slice(start) : raw;
  const data = JSON.parse(jsonText) as {
    numTotalTests?: number;
    numPassedTests?: number;
    numFailedTests?: number;
    numSkippedTests?: number;
    testResults?: Array<{
      name?: string;
      status?: string;
      message?: string;
      assertionResults?: Array<{
        fullName?: string;
        title?: string;
        ancestorTitles?: string[];
        status?: string;
        failureMessages?: string[];
        duration?: number;
      }>;
    }>;
  };

  const results: Array<{
    name: string;
    suite: string;
    status: TestResultStatus;
    message: string;
    durationMs: number;
  }> = [];
  for (const tr of data.testResults ?? []) {
    const suite = tr.name ? path.basename(tr.name) : "";
    const assertions = tr.assertionResults ?? [];
    // 文件级收集失败(如 import 解析错误):无用例但整体失败,必须记录
    if (assertions.length === 0) {
      const fileErr = (tr as { message?: string }).message ?? "";
      results.push({
        name: suite || "(测试文件)",
        suite,
        status: "failed",
        message: clip(fileErr || "测试文件收集失败", 4000),
        durationMs: 0,
      });
      continue;
    }
    for (const a of assertions) {
      const status = (
        a.status === "passed" || a.status === "failed" || a.status === "skipped"
          ? a.status
          : "skipped"
      ) as TestResultStatus;
      results.push({
        name: a.fullName || a.title || "(未命名用例)",
        suite,
        status,
        message: (a.failureMessages ?? []).join("\n").slice(0, 4000),
        durationMs: Math.round(a.duration ?? 0),
      });
    }
  }
  return {
    total: results.length || data.numTotalTests || 0,
    passed: results.filter((r) => r.status === "passed").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    durationMs: 0,
    results,
  };
}

export async function runTests(
  projectId: string,
  userId: string,
  kind: TestKind,
): Promise<TestRunDto> {
  await assertProjectOwner(projectId, userId);
  await ensureVitest(projectId);

  const clientDir = clientDirOf(projectId);
  const testsDir = path.join(clientDir, "tests");
  if (!fs.existsSync(testsDir) || fs.readdirSync(testsDir).length === 0) {
    throw new TestingError("还没有测试文件;请先让 AI 生成测试", "no_tests");
  }

  const run = await db.testRun.create({
    data: { projectId, kind, status: "running", command: "npx vitest run (client)" },
  });
  await logActivity(
    projectId,
    "system",
    `运行${kind === "unit" ? "单元" : ""}测试`,
    `TestRun ${run.id}`,
  );

  const startedAt = Date.now();
  let rawOutput = "";
  try {
    const { stdout, stderr } = await execFileAsync(
      "npx",
      ["vitest", "run", "--reporter=json", "--outputFile=.vitest-result.json", "--root", "."],
      {
        cwd: clientDir,
        timeout: 300_000,
        windowsHide: true,
        maxBuffer: 24 * 1024 * 1024,
        shell: process.platform === "win32",
      },
    );
    rawOutput = `${stdout}\n${stderr}`;
  } catch (e) {
    // vitest 有失败用例时以非零码退出,stdout 仍含 JSON
    const err = e as { stdout?: string; stderr?: string };
    rawOutput = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
  }

  const resultFile = path.join(clientDir, ".vitest-result.json");
  let parsed: ReturnType<typeof parseVitestJson> | null = null;
  try {
    if (fs.existsSync(resultFile)) {
      parsed = parseVitestJson(fs.readFileSync(resultFile, "utf8"));
      fs.rmSync(resultFile);
    } else {
      parsed = parseVitestJson(rawOutput);
    }
  } catch (e) {
    await db.testRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt,
        output: clip(rawOutput, 12_000),
      },
    });
    throw new TestingError(
      `测试执行失败(输出无法解析):${e instanceof Error ? e.message : String(e)}\n原始输出:${clip(rawOutput, 1500)}`,
      "parse_failed",
    );
  }

  const finishedAt = new Date();
  const durationMs = Date.now() - startedAt;
  const status = parsed.failed > 0 || parsed.total === 0 ? "failed" : "passed";

  const updated = await db.testRun.update({
    where: { id: run.id },
    data: {
      status,
      total: parsed.total,
      passed: parsed.passed,
      failed: parsed.failed,
      skipped: parsed.skipped,
      durationMs,
      output: clip(rawOutput, 12_000),
      finishedAt,
      results: {
        create: parsed.results.map((r) => ({
          name: r.name,
          suite: r.suite,
          status: r.status,
          message: r.message,
          durationMs: r.durationMs,
        })),
      },
    },
    include: { results: true },
  });

  await logActivity(
    projectId,
    "system",
    `测试完成:${parsed.passed}/${parsed.total} 通过`,
    status === "failed" ? `${parsed.failed} 个失败,可在测试中心分析修复` : "",
  );

  return toRunDto(updated as TestRun & { results: TestResult[] });
}

function toRunDto(run: TestRun & { results: TestResult[] }): TestRunDto {
  return testRunDtoSchema.parse({
    ...run,
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    results: run.results.map((r) => ({
      ...r,
      analysis: r.analysis ? safeParseAnalysis(r.analysis) : null,
    })),
  });
}

function safeParseAnalysis(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function listRuns(
  projectId: string,
  userId: string,
  limit = 10,
): Promise<TestRunDto[]> {
  await assertProjectOwner(projectId, userId);
  const rows = await db.testRun.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { results: true },
  });
  return rows.map((r) => toRunDto(r));
}

export async function getRun(
  projectId: string,
  userId: string,
  runId: string,
): Promise<TestRunDto | null> {
  await assertProjectOwner(projectId, userId);
  const row = await db.testRun.findFirst({
    where: { id: runId, projectId },
    include: { results: true },
  });
  return row ? toRunDto(row) : null;
}

// ===== AI 失败分析 =====

export async function analyzeFailures(
  projectId: string,
  userId: string,
  runId: string,
): Promise<TestRunDto> {
  await assertProjectOwner(projectId, userId);
  const run = await db.testRun.findFirst({
    where: { id: runId, projectId },
    include: { results: true },
  });
  if (!run) throw new TestingError("测试运行不存在", "not_found");
  const failures = run.results.filter((r) => r.status === "failed" && !r.analysis);
  if (failures.length === 0) return testRunDtoSchema.parse(await getRunDtoRaw(runId, userId));

  const { projectText, requirementText } = await buildProjectRequirementText(projectId, userId);
  const architecture = await getArchitecture(projectId, userId);
  const archSummary = architecture?.summary ?? "(无架构)";

  const output = await generateObjectCompat({
    system:
      "你是测试失败分析专家。对每个失败用例输出:错误摘要、关键堆栈、最可能的相关源文件、关联的需求点、可能的根因、建议修复方向。文本简体中文,只输出符合 JSON Schema 的内容。",
    prompt: `项目:${projectText.slice(0, 800)}\n\n需求摘要:${requirementText.slice(0, 1500)}\n\n架构:${archSummary.slice(0, 800)}\n\n失败用例:\n${failures
      .map((f, i) => `${i + 1}. 用例:${f.name}\n   失败信息:${clip(f.message, 1200)}`)
      .join("\n\n")}`,
    schema: failureAnalysisOutputSchema,
    schemaName: "FailureAnalysis",
    maxOutputTokens: 12_000,
    signal: AbortSignal.timeout(280_000),
  }).catch((error) => {
    if (error instanceof AiNotConfiguredError) throw error;
    throw new TestingError(
      `失败分析出错:${error instanceof Error ? error.message : String(error)}`,
      "ai_failed",
    );
  });

  // 按输入顺序对应(failures 顺序即 prompt 中列出的顺序);名匹配作为兜底
  for (const [i, r] of output.results.entries()) {
    const target =
      failures.find((f) => f.name.includes(r.testName) || r.testName.includes(f.name)) ??
      failures[i];
    if (!target) continue;
    await db.testResult.update({
      where: { id: target.id },
      data: { analysis: JSON.stringify(r.analysis) },
    });
  }

  const dto = await getRunDtoRaw(runId, userId);
  if (!dto) throw new TestingError("读取失败", "not_found");
  return dto;
}

async function getRunDtoRaw(runId: string, userId: string): Promise<TestRunDto | null> {
  const row = await db.testRun.findFirst({
    where: { id: runId, project: { userId } },
    include: { results: true },
  });
  return row ? toRunDto(row) : null;
}

// ===== AI Fix(修代码/修测试 + 回归) =====

export async function fixFailures(
  projectId: string,
  userId: string,
  runId: string,
  onlyResultId?: string,
): Promise<{ fixed: number; newRunId: string | null }> {
  await assertProjectOwner(projectId, userId);
  const run = await db.testRun.findFirst({
    where: { id: runId, projectId },
    include: { results: true },
  });
  if (!run) throw new TestingError("测试运行不存在", "not_found");

  const failures = run.results.filter(
    (r) => r.status === "failed" && !r.ignored && (!onlyResultId || r.id === onlyResultId),
  );
  if (failures.length === 0) return { fixed: 0, newRunId: null };

  const clientDir = clientDirOf(projectId);
  let fixed = 0;
  const MAX_FIX = 5;

  for (const failure of failures.slice(0, MAX_FIX)) {
    // 找最可能的相关源文件内容(清洗 AI 给的路径:去括号备注、去 client/ 前缀)
    const analysis = (failure.analysis ?? null) as { relatedFile?: string } | null;
    const cleanPath = (p: string | undefined) =>
      (p ?? "")
        .replace(/^client\//, "")
        .replace(/[（(].*$/, "")
        .trim();
    const candidates = [
      cleanPath(analysis?.relatedFile),
      ...guessSourceFiles(failure.message),
    ].filter((p): p is string => Boolean(p) && fs.existsSync(path.join(clientDir, p)));
    const relatedPath = candidates[0] ?? "";
    const relatedContent = relatedPath
      ? fs.readFileSync(path.join(clientDir, relatedPath), "utf8")
      : "";
    // 失败测试文件本身的内容(failure.suite = xxx.test.js)
    const testFileRel = "tests/" + failure.suite;
    const testFileAbs = path.join(clientDir, testFileRel);
    const testFileContent = fs.existsSync(testFileAbs) ? fs.readFileSync(testFileAbs, "utf8") : "";

    const fix = await generateObjectCompat({
      system:
        "你是测试修复专家。给定失败用例、失败测试文件内容与相关源文件,判断是【被测代码有 bug】还是【测试本身写错】,然后修复。target=code 修复被测代码(path 填被测文件);target=test 修复测试文件(path 必须填该测试文件)。content 必须是修复后的【完整】文件内容。保持风格,最小修改。文本简体中文。",
      prompt: `失败用例:${failure.name}
失败信息:
${clip(failure.message, 2500)}

${analysis ? `失败分析:${JSON.stringify(analysis).slice(0, 800)}` : "(未做 AI 分析)"}

${relatedPath ? `相关源文件 ${relatedPath} 当前内容:\n\`\`\`\n${clip(relatedContent, 10_000)}\n\`\`\`` : "(无明确相关文件;测试文件在 client/tests/ 下)"}

失败测试文件 ${testFileRel} 当前内容:
\`\`\`
${clip(testFileContent, 10_000)}
\`\`\`

请修复(优先修被测代码;仅当测试断言明显错误时才改测试)。`,
      schema: testFixOutputSchema,
      schemaName: "TestFix",
      maxOutputTokens: 12_000,
      signal: AbortSignal.timeout(280_000),
    }).catch((error) => {
      if (error instanceof AiNotConfiguredError) throw error;
      throw new TestingError(
        `AI 修复失败:${error instanceof Error ? error.message : String(error)}`,
        "ai_failed",
      );
    });

    // AI 拒绝修复或输出非代码(说明性文字)时不写盘,避免污染文件
    const looksLikeCode =
      fix.content.length > 80 &&
      /(import|export|const |function |describe\(|it\(|def |class )/.test(fix.content) &&
      !/未提供|无法|请补充|请提供/.test(fix.content.slice(0, 200));
    if (!looksLikeCode) {
      throw new TestingError(
        `AI 未能修复该用例(输出非代码):${clip(fix.explanation || fix.content, 200)}`,
        "fix_rejected",
      );
    }

    // 写盘 + 留痕(target=test 时强制写回测试文件自身,防 AI 乱选路径覆盖他处)
    // fixPath 相对 client 目录;写盘用它,变更集记录统一用相对工作区根的
    // client/ 前缀路径(与其他变更集一致,undo 按 workspace 根解析)
    const fixPath =
      fix.target === "test" ? testFileRel : fix.path.replaceAll("\\", "/").replace(/^client\//, "");
    const changePath = `client/${fixPath}`;
    const abs = safeJoinClient(projectId, fixPath);
    const before = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, fix.content, "utf8");
    await db.changeSet.create({
      data: {
        projectId,
        title: `修复失败测试:${failure.name.slice(0, 50)}`,
        summary: `${fix.explanation}(target=${fix.target})`,
        source: "ai",
        status: "accepted",
        appliedAt: new Date(),
        changes: {
          create: {
            path: changePath,
            action: before === null ? "create" : "modify",
            beforeContent: before,
            afterContent: fix.content,
          },
        },
      },
    });
    fixed++;
  }

  // 回归:重新执行测试(新 TestRun)
  const newRun = await runTests(projectId, userId, run.kind as TestKind);
  await logActivity(
    projectId,
    "system",
    `回归测试完成:${newRun.passed}/${newRun.total} 通过(修复 ${fixed} 处)`,
  );
  return { fixed, newRunId: newRun.id };
}

function guessSourceFiles(message: string): string[] {
  const matches = message.match(/[\w-]+\/(?:[\w-]+\/)*[\w-]+\.(?:js|mjs|vue)/g) ?? [];
  return [...new Set(matches)];
}

function safeJoinClient(projectId: string, rel: string): string {
  const clientDir = clientDirOf(projectId);
  const full = path.resolve(clientDir, rel);
  if (!full.startsWith(path.resolve(clientDir) + path.sep)) {
    throw new TestingError("非法路径", "invalid_path");
  }
  return full;
}
