import { db } from "@/server/db";
import type { AgentTask } from "@prisma/client";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { generateObjectCompat } from "@/server/ai/compat";
import { z } from "zod";
import { generatePlan, generateImplementation } from "@/server/agents/coding-agent";
import { buildCodingContext } from "@/server/agents/context";
import { createPendingChangeSet, acceptChangeSet } from "@/server/changesets";
import { resolveProjectDir, safeJoin } from "@/server/workspace/paths";
import { readFileContent } from "@/server/workspace/files";
import { repairEvidenceFromInvestigation } from "@/lib/investigation-repair";
import { assertFocusedRepairPlan } from "@/lib/repair-strategy";
import { logActivity } from "@/server/activity";
import { commitAll, getStatus } from "@/server/git";
import { generateCommitMessage, fallbackCommitMessage } from "@/server/git-ai";
import { runProjectAcceptance } from "./acceptance";
import { investigateAcceptanceFailure } from "./investigation";
import { fullProjectAcceptanceFailureFingerprint } from "@/lib/full-project";
import { selectRepairCheck, focusedRepairPrompt, assertRepairChanges } from "@/lib/repair-strategy";
import { assertImplementationCoverage } from "@/lib/generation-quality";
import {
  createGenerationBatches,
  implementationOutputTokens,
  selectRelevantGenerationPaths,
} from "@/lib/generation-efficiency";
import { listProjectFilePaths } from "@/server/workspace/search";
import { loadCodexCheckpoint, saveCodexCheckpoint, type CodexCheckpoint } from "./codex-checkpoint";

/**
 * Phase 5:自主开发任务编排器(Autonomous Development Loop)。
 * 流程:analyze → plan → code(变更集自动应用)→ install(可选)→ check → fix 循环。
 * 约束:暂停/恢复/取消、每步落库留痕、失败保留完整错误上下文、相同失败无进展时停止。
 */

const execFileAsync = promisify(execFile);

export interface TaskControl {
  cancelled: boolean;
  paused: boolean;
  abort: AbortController;
  projectId?: string;
  engine?: "codex" | "legacy";
}

const controllerGlobal = globalThis as typeof globalThis & {
  graduateStudioAgentControllers?: Map<string, TaskControl>;
};
const controllers = (controllerGlobal.graduateStudioAgentControllers ??= new Map<
  string,
  TaskControl
>());

export function registerTaskController(taskId: string, projectId?: string): TaskControl | null {
  if (
    controllers.has(taskId) ||
    (projectId && [...controllers.values()].some((ctrl) => ctrl.projectId === projectId))
  )
    return null;
  const ctrl: TaskControl = {
    cancelled: false,
    paused: false,
    abort: new AbortController(),
    projectId,
  };
  controllers.set(taskId, ctrl);
  return ctrl;
}
export function releaseTaskController(taskId: string): void {
  controllers.delete(taskId);
}

export function isRunningInProcess(taskId: string): boolean {
  return controllers.has(taskId);
}

export function pauseTask(taskId: string): boolean {
  const ctrl = controllers.get(taskId);
  if (!ctrl) return false;
  ctrl.paused = true;
  if (ctrl.engine === "codex") ctrl.abort.abort();
  return true;
}

export function resumeTask(taskId: string): boolean {
  const ctrl = controllers.get(taskId);
  if (!ctrl || ctrl.engine === "codex") return false;
  ctrl.paused = false;
  return true;
}

export function cancelTask(taskId: string): boolean {
  const ctrl = controllers.get(taskId);
  if (!ctrl) return false;
  ctrl.cancelled = true;
  ctrl.paused = false;
  ctrl.abort.abort();
  return true;
}

class TaskCancelled extends Error {}

/**
 * 任务成功后的自动提交:AI 生成 Conventional Commits 信息(失败用兜底标题),
 * 提交正文携带任务 ID/标题/变更摘要,commit hash 回写 AgentTask。
 * 提交失败不吞掉任务成功状态,只记日志。
 */
async function autoCommitTask(
  projectId: string,
  task: AgentTask,
  planTitle: string,
  changedFiles: Array<{ path: string; action: string }>,
  fixAttempts: number,
): Promise<void> {
  try {
    const status = await getStatus(projectId);
    if (!status.initialized || status.changes.length === 0) return;

    const changeSummary = changedFiles
      .slice(0, 12)
      .map((c) => `${c.action} ${c.path}`)
      .join("; ");
    let message = fallbackCommitMessage(planTitle);
    let body = `Task: ${task.id}\n标题:${planTitle}\n变更:${changeSummary}\n修复:${fixAttempts} 次`;

    try {
      const ai = await generateCommitMessage({
        projectId,
        taskContext: {
          title: planTitle,
          summary: `自主开发任务,修改 ${changedFiles.length} 个文件,自动修复 ${fixAttempts} 次`,
        },
      });
      if (ai.message) message = ai.message;
      if (ai.body)
        body = `${ai.body}\n\nTask: ${task.id}\n变更:${changeSummary}\n修复:${fixAttempts} 次`;
    } catch {
      // AI 不可用 → 兜底信息
    }

    const commit = await commitAll(projectId, body ? `${message}\n\n${body}` : message);
    await db.agentTask.update({
      where: { id: task.id },
      data: { gitCommitHash: commit.hash },
    });
    await logActivity(
      projectId,
      "ai",
      `Agent 自动提交 ${commit.shortHash}:${message}`,
      `分支 ${status.branch} · ${commit.files} 个文件\n${body.slice(0, 500)}`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logActivity(projectId, "ai", "Agent 自动提交失败(不影响任务结果)", msg.slice(0, 400));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 每个副作用步骤前的关卡:暂停挂起 / 取消抛出 */
export async function gate(ctrl: TaskControl): Promise<void> {
  while (ctrl.paused && !ctrl.cancelled) {
    await sleep(600);
  }
  if (ctrl.cancelled) throw new TaskCancelled();
}

const clip = (s: string, n = 8000) => (s.length > n ? `${s.slice(0, n)}\n…(截断)` : s);

export async function runStep<T>(
  task: AgentTask,
  index: number,
  kind: string,
  title: string,
  fn: (ctx: { setChangeSet: (id: string) => void }) => Promise<T>,
): Promise<T> {
  await db.agentStep.updateMany({
    where: { taskId: task.id, status: "running", index: { lt: index } },
    data: {
      status: "failed",
      finishedAt: new Date(),
      detail: "该次执行已中断，现已开始后续尝试；历史记录保留。",
    },
  });
  const step = await db.agentStep.create({
    data: { taskId: task.id, index, kind, title, status: "running" },
  });
  let changeSetId: string | null = null;
  try {
    const result = await fn({
      setChangeSet: (id) => {
        changeSetId = id;
      },
    });
    await db.agentStep.update({
      where: { id: step.id },
      data: {
        status: "done",
        finishedAt: new Date(),
        changeSetId,
        detail:
          typeof result === "string"
            ? result.startsWith("ACCEPTANCE_REPORT\n")
              ? result
              : clip(result, 24_000)
            : "",
      },
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.agentStep.update({
      where: { id: step.id },
      data: { status: "failed", detail: message.slice(0, 8000), finishedAt: new Date() },
    });
    throw error;
  }
}

export async function runSkippedStep(
  task: AgentTask,
  index: number,
  kind: string,
  title: string,
  detail: string,
) {
  const step = await db.agentStep.create({
    data: {
      taskId: task.id,
      index,
      kind,
      title,
      status: "skipped",
      detail,
      finishedAt: new Date(),
    },
  });
  return step;
}

async function setTaskStatus(taskId: string, status: string): Promise<void> {
  await db.agentTask.update({ where: { id: taskId }, data: { status } });
}

interface CheckError {
  file: string;
  message: string;
}

/** 语法自检:变更集内的 JS(node --check,ESM 复制为 .mjs)与 JSON(JSON.parse)。 */
async function checkChangedFiles(
  projectDir: string,
  files: Array<{ path: string; action: string }>,
): Promise<{ errors: CheckError[]; checked: number; skipped: number }> {
  const errors: CheckError[] = [];
  let checked = 0;
  let skipped = 0;

  for (const file of files) {
    if (file.action === "delete") continue;
    const ext = path.extname(file.path).toLowerCase();
    const abs = safeJoin(projectDir, file.path);
    if (!fs.existsSync(abs)) continue;

    if (ext === ".json") {
      checked++;
      try {
        JSON.parse(fs.readFileSync(abs, "utf8"));
      } catch (e) {
        errors.push({
          file: file.path,
          message: `JSON 解析失败:${e instanceof Error ? e.message : String(e)}`,
        });
      }
      continue;
    }
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
      checked++;
      const tmpFile = path.join(
        path.dirname(abs),
        `.gs-check-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
      );
      try {
        fs.copyFileSync(abs, tmpFile);
        await execFileAsync(process.execPath, ["--check", tmpFile], {
          timeout: 30_000,
          windowsHide: true,
        });
      } catch (e) {
        const err = e as { stderr?: string; message?: string };
        const msg = (err.stderr || err.message || "")
          .split("\n")
          .filter((l) => l && !l.includes(tmpFile))
          .join("\n");
        errors.push({ file: file.path, message: clip(msg || "语法错误", 2000) });
      } finally {
        if (fs.existsSync(tmpFile)) fs.rmSync(tmpFile);
      }
      continue;
    }
    skipped++;
  }
  return { errors, checked, skipped };
}

const fixOutputSchema = z.object({
  explanation: z.string().max(500).describe("错误原因与修复说明,2-3 句话"),
  content: z.string().min(1).describe("修复后的完整文件内容"),
});

async function generateFix(input: {
  message: string;
  filePath: string;
  fileContent: string;
  errors: string;
  signal: AbortSignal;
}): Promise<z.infer<typeof fixOutputSchema>> {
  return generateObjectCompat({
    system:
      "你是软件调试专家。给定一个文件的当前内容与自检错误输出,修复文件使错误消除。content 必须是修复后的【完整】文件内容(不要 diff、不要省略)。保持原有功能与风格,做最小必要修改。文本用简体中文。",
    prompt: `开发任务:${input.message}

文件:${input.filePath}

当前内容:
\`\`\`
${input.fileContent}
\`\`\`

自检错误:
\`\`\`
${input.errors}
\`\`\``,
    schema: fixOutputSchema,
    schemaName: "CodeFix",
    signal: input.signal,
  });
}

export async function executeTask(
  task: AgentTask,
  projectId: string,
  userId: string,
  message: string,
  _maxSteps: number,
  ctrl: TaskControl,
): Promise<void> {
  let index = 0;
  const projectDir = resolveProjectDir(projectId);
  const lastErrorContext = "";

  try {
    await db.agentTask.update({
      where: { id: task.id },
      data: { status: "analyzing", startedAt: new Date() },
    });
    await gate(ctrl);

    // 1. 分析
    const context = await runStep(task, index++, "analyze", "分析项目与需求", async () => {
      const ctx = await buildCodingContext(projectId, userId);
      return clip(
        [
          ctx.fileTreeText.startsWith("(") ? "工作区暂为空" : "文件树已建立",
          ctx.requirementText.startsWith("(") ? "无需求分析" : "有需求分析",
          ctx.architectureText.startsWith("(") ? "无架构设计" : "有架构与数据库设计",
          "",
          ctx.architectureText.slice(0, 2500),
        ].join("\n"),
        4000,
      );
    });
    void context;

    // 2. 规划
    await gate(ctrl);
    await setTaskStatus(task.id, "planning");
    const planHolder: { value: Awaited<ReturnType<typeof generatePlan>> | null } = { value: null };
    await runStep(task, index++, "plan", "制定开发计划", async () => {
      planHolder.value = await generatePlan({
        projectId,
        userId,
        message,
        selectedFilePaths: [],
        signal: ctrl.abort.signal,
      });
      await db.agentTask.update({
        where: { id: task.id },
        data: { title: planHolder.value.title },
      });
      return clip(JSON.stringify(planHolder.value.steps, null, 1), 6000);
    });
    const plan = planHolder.value;
    if (!plan) throw new Error("计划生成失败");

    // 分批实现；按原始文件估算输出大小，保持计划顺序，避免一次输出整个系统。
    const changedFiles: Array<{ path: string; action: string }> = [];
    const existingLengths: Record<string, number> = {};
    for (const step of plan.steps) {
      if (step.action === "modify") {
        try {
          existingLengths[step.path] = readFileContent(projectId, userId, step.path).content.length;
        } catch {
          // 生成质量校验会拒绝缺失的 modify 原文；这里只跳过无法读取的可选估算。
        }
      }
    }
    const batchIndices = createGenerationBatches(plan.steps, existingLengths);
    const batches = batchIndices.map((indices) => indices.map((index) => plan.steps[index]));
    for (const [batchIndex, steps] of batches.entries()) {
      const currentPaths = steps.map((step) => step.path);
      const allPaths = listProjectFilePaths(projectId, userId);
      const relevantPaths = selectRelevantGenerationPaths(allPaths, currentPaths);

      await gate(ctrl);
      await setTaskStatus(task.id, "coding");
      await runStep(
        task,
        index++,
        "code",
        `实现第 ${batchIndex + 1}/${batches.length} 批：${steps.map((step) => step.path).join("、")}`,
        async ({ setChangeSet }) => {
          const output = await generateImplementation({
            projectId,
            userId,
            message: `${message}\n\n当前实现计划：${JSON.stringify(steps)}\n当前仅执行第 ${batchIndex + 1}/${batches.length} 批，保留先前批次功能并匹配接口。`,
            plan: { ...plan, steps },
            selectedFilePaths: relevantPaths,
            maxOutputTokens: implementationOutputTokens(steps, existingLengths),
            signal: ctrl.abort.signal,
          });
          await gate(ctrl);
          const pending = await createPendingChangeSet({
            projectId,
            userId,
            title: `${plan.title} · ${batchIndex + 1}/${batches.length}`,
            summary: output.notes,
            plan: steps,
            changes: output.changes.map((change) => ({
              path: change.path,
              action: change.action,
              content: change.content,
            })),
          });
          const accepted = await acceptChangeSet(pending.id, userId);
          setChangeSet(accepted.id);
          changedFiles.push(
            ...accepted.changes.map((change) => ({ path: change.path, action: change.action })),
          );
          return `${output.notes}\n已应用 ${accepted.changes.length} 个文件变更：\n${accepted.changes.map((change) => `${change.action} ${change.path}`).join("\n")}`;
        },
      );
    }

    // 4. 依赖安装(仅当前端 package.json 被修改;失败不阻断)
    await gate(ctrl);
    const needsNpm = changedFiles.some(
      (c) => c.path.endsWith("package.json") && c.path.startsWith("client"),
    );
    if (needsNpm) {
      await setTaskStatus(task.id, "coding");
      await runStep(task, index++, "install", "安装前端依赖(npm install)", async () => {
        try {
          const { stdout, stderr } = await execFileAsync(
            "npm",
            ["install", "--prefix", "client", "--no-audit", "--no-fund", "--loglevel", "error"],
            {
              cwd: projectDir,
              timeout: 600_000,
              windowsHide: true,
              maxBuffer: 8 * 1024 * 1024,
              shell: process.platform === "win32",
              signal: ctrl.abort.signal,
            },
          );
          return clip(`npm install 完成\n${stdout || stderr || "(无输出)"}`, 3000);
        } catch (e) {
          const err = e as { stderr?: string; message?: string };
          throw new Error(
            `依赖安装失败，停止后续验收：${clip(err.stderr || err.message || "", 1500)}`,
          );
        }
      });
    } else {
      await runSkippedStep(task, index++, "install", "依赖清单未变化,跳过安装", "skipped");
    }

    // 5. 自检
    await gate(ctrl);
    let checkErrors: CheckError[] = [];
    await runStep(task, index++, "check", "语法自检(node --check / JSON 校验)", async () => {
      await setTaskStatus(task.id, "checking");
      const r = await checkChangedFiles(projectDir, changedFiles);
      checkErrors = r.errors;
      return `检查 ${r.checked} 个文件,跳过 ${r.skipped} 个(非 JS/JSON),错误 ${r.errors.length} 个${
        r.errors.length ? "\n" + r.errors.map((e) => `${e.file}: ${e.message}`).join("\n") : ""
      }`;
    });

    // Continue real repairs while diagnostics change; stop repeated failures, not attempt counts.
    let attempts = 0;
    let repairedFailure: string | undefined;
    while (checkErrors.length > 0) {
      await gate(ctrl);
      const failure = JSON.stringify(
        checkErrors
          .map(({ file, message }) => ({ file, message: message.replace(/\s+/g, " ").trim() }))
          .sort((a, b) => a.file.localeCompare(b.file)),
      );
      if (failure === repairedFailure)
        throw new Error(`自检修复未取得进展，相同错误再次出现，停止重复修复：${failure}`);
      repairedFailure = failure;
      attempts++;
      await db.agentTask.update({
        where: { id: task.id },
        data: { fixAttempts: attempts, status: "fixing" },
      });
      const err = checkErrors[0];
      const fileAbs = safeJoin(projectDir, err.file);
      const fileContent = fs.existsSync(fileAbs) ? fs.readFileSync(fileAbs, "utf8") : "";

      await runStep(task, index++, "fix", `AI 修复 ${err.file}(第 ${attempts} 次)`, async () => {
        const output = await generateFix({
          message,
          filePath: err.file,
          fileContent,
          errors: err.message,
          signal: ctrl.abort.signal,
        });
        const before = fs.existsSync(fileAbs) ? fs.readFileSync(fileAbs, "utf8") : null;
        assertImplementationCoverage(
          [{ path: err.file, action: before === null ? "create" : "modify" }],
          [
            {
              path: err.file,
              action: before === null ? "create" : "modify",
              content: output.content,
            },
          ],
        );
        await gate(ctrl);
        fs.writeFileSync(fileAbs, output.content, "utf8");
        await db.changeSet.create({
          data: {
            projectId,
            title: `修复 ${err.file}`,
            summary: output.explanation,
            source: "ai",
            status: "accepted",
            appliedAt: new Date(),
            changes: {
              create: {
                path: err.file,
                action: before === null ? "create" : "modify",
                beforeContent: before,
                afterContent: output.content,
              },
            },
          },
        });
        await logActivity(projectId, "ai", `Agent 修复 ${err.file}`, output.explanation);
        return clip(output.explanation, 2000);
      });

      await gate(ctrl);
      await runStep(task, index++, "check", `重新自检(第 ${attempts} 轮修复后)`, async () => {
        const r = await checkChangedFiles(projectDir, changedFiles);
        checkErrors = r.errors;
        return r.errors.length === 0
          ? "全部通过"
          : `仍有 ${r.errors.length} 个错误:\n${r.errors
              .map((e) => `${e.file}: ${e.message.slice(0, 300)}`)
              .join("\n")}`;
      });
    }

    // 7. 结论
    if (checkErrors.length > 0) {
      throw new Error(
        `自检未通过(已尝试修复 ${attempts} 次)。保留完整错误上下文:\n${checkErrors
          .map((e) => `${e.file}: ${e.message}`)
          .join("\n---\n")}`,
      );
    }

    await gate(ctrl);
    await setTaskStatus(task.id, "checking");
    let acceptance: Awaited<ReturnType<typeof runProjectAcceptance>> | undefined;
    await runStep(task, index++, "check", "工程验收：真实构建、测试与占位检查", async () => {
      acceptance = await runProjectAcceptance(projectDir, { signal: ctrl.abort.signal });
      return `ACCEPTANCE_REPORT\n${JSON.stringify({ ...acceptance, checks: acceptance.checks.map((check) => ({ ...check, output: check.output.slice(0, 2000) + (check.output.length > 2000 ? "\n（输出已截取）" : "") })) })}`;
    });
    await gate(ctrl);
    const attemptedAcceptanceFailures = new Set<string>();
    while (acceptance && acceptance.status !== "passed") {
      const fingerprint = fullProjectAcceptanceFailureFingerprint(acceptance);
      if (attemptedAcceptanceFailures.has(fingerprint)) break;
      attemptedAcceptanceFailures.add(fingerprint);
      const focusId = selectRepairCheck(acceptance);
      const investigation = await runStep(
        task,
        index++,
        "diagnostic",
        `工程工具调查：${focusId}`,
        () =>
          investigateAcceptanceFailure({
            projectDir,
            report: acceptance!,
            focusId,
            signal: ctrl.abort.signal,
            onObservation: async (observation, hypothesis) => {
              await gate(ctrl);
              await runStep(
                task,
                index++,
                "diagnostic",
                `调查工具：${observation.request.tool}`,
                async () => JSON.stringify({ hypothesis, ...observation }),
              );
            },
          }),
      );
      await runStep(task, index++, "diagnostic", "工程调查结论", async () =>
        JSON.stringify({
          disposition: investigation.disposition,
          summary: investigation.summary,
          paths: investigation.paths,
        }),
      );
      const repairEvidence = repairEvidenceFromInvestigation(acceptance, focusId, investigation);
      if (!repairEvidence) break;
      await gate(ctrl);
      await setTaskStatus(task.id, "fixing");
      const repairMessage = `${message}\n${focusedRepairPrompt(repairEvidence, focusId)}\n工具调查结论：${investigation.summary}`;
      const repairPlan = await runStep(task, index++, "plan", "依据工程证据制定最小修复", () =>
        generatePlan({
          projectId,
          userId,
          message: repairMessage,
          selectedFilePaths: investigation.paths,
          signal: ctrl.abort.signal,
          moduleScoped: true,
        }),
      );
      assertFocusedRepairPlan(repairPlan, focusId, investigation.paths);
      for (let cursor = 0; cursor < repairPlan.steps.length; cursor += 2) {
        await gate(ctrl);
        const steps = repairPlan.steps.slice(cursor, cursor + 2);
        await runStep(task, index++, "fix", "应用有证据的工程修复", async ({ setChangeSet }) => {
          const output = await generateImplementation({
            projectId,
            userId,
            message: repairMessage,
            plan: { ...repairPlan, steps },
            selectedFilePaths: investigation.paths,
            signal: ctrl.abort.signal,
          });
          assertRepairChanges(output.changes, (p) => readFileContent(projectId, userId, p).content);
          await gate(ctrl);
          const pending = await createPendingChangeSet({
            projectId,
            userId,
            title: repairPlan.title,
            summary: output.notes,
            plan: steps,
            changes: output.changes,
          });
          const accepted = await acceptChangeSet(pending.id, userId);
          setChangeSet(accepted.id);
          changedFiles.push(...accepted.changes.map((c) => ({ path: c.path, action: c.action })));
          return output.notes;
        });
      }
      attempts++;
      await db.agentTask.update({
        where: { id: task.id },
        data: { fixAttempts: attempts, status: "checking" },
      });
      await runStep(
        task,
        index++,
        "check",
        `定向验收：${focusId}`,
        async () =>
          `ACCEPTANCE_REPORT\n${JSON.stringify(await runProjectAcceptance(projectDir, { signal: ctrl.abort.signal, onlyCheckIds: [focusId] }))}`,
      );
      await runStep(task, index++, "check", "修复后完整工程验收", async () => {
        acceptance = await runProjectAcceptance(projectDir, { signal: ctrl.abort.signal });
        return `ACCEPTANCE_REPORT\n${JSON.stringify(acceptance)}`;
      });
      await gate(ctrl);
    }
    if (!acceptance || acceptance.status !== "passed") {
      throw new Error(
        `工程验收${acceptance?.status === "blocked" ? "受阻" : "未通过"}，不能标记任务完成。${
          acceptance?.checks
            .filter((check) => check.status === "failed" || check.status === "blocked")
            .map((check) => `${check.label}：${check.output}`)
            .join("\n")
            .slice(0, 4000) ?? "无验收报告"
        }`,
      );
    }
    await logActivity(
      projectId,
      "ai",
      `Agent 工程检查通过:${plan.title}`,
      `工程构建与测试检查通过，共 ${index} 步，修复 ${attempts} 次；仍需业务、数据库、算法与人工交付验收。`,
    );

    // 8. 自动提交(稳定版本落 git,可随时回滚;取消不影响已完成的提交记录)
    await gate(ctrl);
    await runStep(task, index++, "note", "自动提交稳定版本(git)", async () => {
      await autoCommitTask(projectId, task, plan.title, changedFiles, attempts);
      const updated = await db.agentTask.findUnique({
        where: { id: task.id },
        select: { gitCommitHash: true },
      });
      return updated?.gitCommitHash
        ? `已提交 ${updated.gitCommitHash.slice(0, 7)}(可在版本控制页查看/回滚)`
        : "无变更需要提交(工作区干净)";
    });
    await gate(ctrl);
    await db.agentTask.update({
      where: { id: task.id },
      data: { status: "completed", finishedAt: new Date(), error: null },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isCancel = error instanceof TaskCancelled || ctrl.cancelled;
    await db.agentTask.update({
      where: { id: task.id },
      data: {
        status: isCancel ? "cancelled" : "failed",
        finishedAt: new Date(),
        error: isCancel ? "任务被用户取消" : clip(message || lastErrorContext, 6000),
      },
    });
    await logActivity(
      projectId,
      "ai",
      `Agent 任务${isCancel ? "取消" : "失败"}:${task.title || message.slice(0, 40)}`,
      clip(message, 1500),
    );
  } finally {
    controllers.delete(task.id);
  }
}

/** 启动任务(进程内异步执行)。 */
export function startAgentTask(
  task: AgentTask,
  projectId: string,
  userId: string,
  message: string,
  maxSteps: number,
  mode: "local" | "full" = "local",
): boolean {
  const ctrl = registerTaskController(task.id, projectId);
  if (!ctrl) return false;
  ctrl.engine = process.env.GRADUATESTUDIO_AGENT_ENGINE === "codex" ? "codex" : "legacy";
  if (ctrl.engine === "codex") {
    dispatchCodex(task, projectId, userId, message, ctrl, { mode });
    return true;
  }
  if (mode === "full") {
    void import("./full-project")
      .then((fullProject) =>
        fullProject.executeFullProjectTask(task, projectId, userId, message, maxSteps, ctrl),
      )
      .catch(async (error: unknown) => {
        releaseTaskController(task.id);
        await db.agentTask.update({
          where: { id: task.id },
          data: {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
            finishedAt: new Date(),
          },
        });
      });
    return true;
  }
  void executeTask(task, projectId, userId, message, maxSteps, ctrl);
  return true;
}

function dispatchCodex(
  task: AgentTask,
  projectId: string,
  userId: string,
  message: string,
  ctrl: TaskControl,
  options: { mode: "local" | "full"; checkpoint?: CodexCheckpoint },
): void {
  void import("./codex-task")
    .then((module) => module.executeCodexTask(task, projectId, userId, message, ctrl, options))
    .catch(async (error: unknown) => {
      const cp = await loadCodexCheckpoint(projectId, task.id);
      if (
        cp &&
        (cp.pendingChangeSetId || ["awaiting_acceptance", "applied_unverified"].includes(cp.phase))
      ) {
        await db.agentTask.update({
          where: { id: task.id },
          data: { status: "paused", error: null, finishedAt: null },
        });
        return;
      }
      if (cp && !cp.pendingChangeSetId) {
        cp.phase = ctrl.cancelled ? "cancelled" : ctrl.paused ? "paused" : "failed";
        cp.error =
          ctrl.cancelled || ctrl.paused
            ? null
            : error instanceof Error
              ? error.message
              : String(error);
        await saveCodexCheckpoint(cp);
      }
      await db.agentTask.update({
        where: { id: task.id },
        data: {
          status: ctrl.cancelled ? "cancelled" : ctrl.paused ? "paused" : "failed",
          error:
            ctrl.cancelled || ctrl.paused
              ? null
              : error instanceof Error
                ? error.message
                : String(error),
          finishedAt: ctrl.paused ? null : new Date(),
        },
      });
    })
    .finally(() => releaseTaskController(task.id));
}

/** Resume the engine that owns durable state, never the current environment default. */
export async function resumeAgentTask(
  task: AgentTask,
  projectId: string,
  userId: string,
): Promise<boolean> {
  if (task.projectId !== projectId) throw new Error("任务不属于当前项目");
  if (["completed", "cancelled"].includes(task.status)) throw new Error("终态任务不能继续");
  const checkpoint = await loadCodexCheckpoint(projectId, task.id);
  if (checkpoint) {
    if (
      checkpoint.pendingChangeSetId ||
      ["awaiting_acceptance", "applied_unverified", "completed", "cancelled"].includes(
        checkpoint.phase,
      )
    )
      throw new Error("任务正在等待代码审核或已应用，不能重新运行模型；请在开发工作区查看变更。");
    const ctrl = registerTaskController(task.id, projectId);
    if (!ctrl) return false;
    ctrl.engine = "codex";
    dispatchCodex(task, projectId, userId, checkpoint.message, ctrl, {
      mode: checkpoint.mode,
      checkpoint,
    });
    return true;
  }
  if (process.env.GRADUATESTUDIO_AGENT_ENGINE === "codex")
    throw new Error(
      "这是 Legacy 完整项目检查点，不能在 Codex 模式继续。请显式切换 Legacy 或新建 Codex 任务，禁止自动转换。",
    );
  const { resumeFullProjectTask } = await import("./full-project");
  return resumeFullProjectTask(task, projectId, userId);
}

/** 清理孤儿任务:进程内不在跑但状态仍 active 且超过 10 分钟未更新 → 标记失败。 */
export async function reapOrphanTasks(projectId: string): Promise<void> {
  const active = await db.agentTask.findMany({
    where: {
      projectId,
      status: { in: ["queued", "analyzing", "planning", "coding", "checking", "fixing"] },
    },
  });
  for (const task of active) {
    if (controllers.has(task.id)) continue;
    const { isCodexPostApplyVerificationRunning } = await import("./codex-post-apply");
    if (isCodexPostApplyVerificationRunning(task.id)) continue;
    const staleMs = Date.now() - task.updatedAt.getTime();
    if (staleMs > 10 * 60 * 1000) {
      const checkpoint = await loadCodexCheckpoint(projectId, task.id);
      if (
        checkpoint &&
        (checkpoint.pendingChangeSetId ||
          ["awaiting_acceptance", "applied_unverified"].includes(checkpoint.phase))
      ) {
        await db.agentTask.update({
          where: { id: task.id },
          data: { status: "paused", error: null, finishedAt: null },
        });
        continue;
      }
      if (checkpoint && !checkpoint.pendingChangeSetId && checkpoint.phase === "running") {
        checkpoint.phase = "interrupted";
        checkpoint.error = "服务重启，该次执行已中断；可从应用检查点重新尝试。";
        await saveCodexCheckpoint(checkpoint);
      }
      await db.agentStep.updateMany({
        where: { taskId: task.id, status: "running" },
        data: {
          status: "failed",
          finishedAt: new Date(),
          detail: "服务重启，该次执行已中断；可从断点继续。",
        },
      });
      await db.agentTask.update({
        where: { id: task.id },
        data: {
          status: "failed",
          finishedAt: new Date(),
          error: "服务重启,任务中断(可重新发起)",
        },
      });
    }
  }
}
