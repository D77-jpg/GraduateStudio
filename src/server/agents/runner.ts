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
import { logActivity } from "@/server/activity";
import { commitAll, getStatus } from "@/server/git";
import { generateCommitMessage, fallbackCommitMessage } from "@/server/git-ai";

/**
 * Phase 5:自主开发任务编排器(Autonomous Development Loop)。
 * 流程:analyze → plan → code(变更集自动应用)→ install(可选)→ check → fix 循环。
 * 约束:最大执行次数、暂停/恢复/取消、每步落库留痕、失败保留完整错误上下文、无自动死循环。
 */

const execFileAsync = promisify(execFile);

interface TaskControl {
  cancelled: boolean;
  paused: boolean;
  abort: AbortController;
}

const controllers = new Map<string, TaskControl>();

export function isRunningInProcess(taskId: string): boolean {
  return controllers.has(taskId);
}

export function pauseTask(taskId: string): boolean {
  const ctrl = controllers.get(taskId);
  if (!ctrl) return false;
  ctrl.paused = true;
  return true;
}

export function resumeTask(taskId: string): boolean {
  const ctrl = controllers.get(taskId);
  if (!ctrl) return false;
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
async function gate(ctrl: TaskControl): Promise<void> {
  while (ctrl.paused && !ctrl.cancelled) {
    await sleep(600);
  }
  if (ctrl.cancelled) throw new TaskCancelled();
}

const clip = (s: string, n = 8000) => (s.length > n ? `${s.slice(0, n)}\n…(截断)` : s);

async function runStep<T>(
  task: AgentTask,
  index: number,
  kind: string,
  title: string,
  fn: (ctx: { setChangeSet: (id: string) => void }) => Promise<T>,
): Promise<T> {
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
      data: { status: "done", finishedAt: new Date(), changeSetId },
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

async function runSkippedStep(
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
${input.fileContent.slice(0, 12_000)}
\`\`\`

自检错误:
\`\`\`
${input.errors.slice(0, 4000)}
\`\`\``,
    schema: fixOutputSchema,
    schemaName: "CodeFix",
    maxOutputTokens: 12_000,
    signal: input.signal,
  });
}

async function runLoop(
  task: AgentTask,
  projectId: string,
  userId: string,
  message: string,
  maxSteps: number,
  ctrl: TaskControl,
): Promise<void> {
  let index = 0;
  const projectDir = resolveProjectDir(projectId);
  const fixBudget = Math.max(1, Math.min(4, Math.floor(maxSteps / 3)));
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
      planHolder.value = await generatePlan({ projectId, userId, message, selectedFilePaths: [] });
      await db.agentTask.update({
        where: { id: task.id },
        data: { title: planHolder.value.title },
      });
      return clip(JSON.stringify(planHolder.value.steps, null, 1), 6000);
    });
    const plan = planHolder.value;
    if (!plan) throw new Error("计划生成失败");

    // 3. 编码(生成变更集并应用;用户可随时撤销)
    await gate(ctrl);
    await setTaskStatus(task.id, "coding");
    const codeResult = await runStep(
      task,
      index++,
      "code",
      "生成代码变更",
      async ({ setChangeSet }) => {
        const output = await generateImplementation({
          projectId,
          userId,
          message,
          plan,
          selectedFilePaths: [],
        });
        const pending = await createPendingChangeSet({
          projectId,
          userId,
          title: plan.title,
          summary: output.notes,
          plan: plan.steps,
          changes: output.changes.map((c) => ({
            path: c.path,
            action: c.action,
            content: c.content,
          })),
        });
        const accepted = await acceptChangeSet(pending.id, userId);
        setChangeSet(accepted.id);
        return `已应用 ${accepted.changes.length} 个文件变更:${accepted.changes
          .map((c) => `${c.action} ${c.path}`)
          .join("; ")}`;
      },
    );
    void codeResult;

    // 变更文件清单(用于安装判断与自检)
    const acceptedSet = await db.changeSet.findFirst({
      where: { projectId, title: plan.title, source: "ai" },
      orderBy: { createdAt: "desc" },
      include: { changes: { select: { path: true, action: true } } },
    });
    const changedFiles = acceptedSet?.changes ?? [];

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
            { cwd: projectDir, timeout: 600_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
          );
          return clip(`npm install 完成\n${stdout || stderr || "(无输出)"}`, 3000);
        } catch (e) {
          const err = e as { stderr?: string; message?: string };
          return `npm install 失败(不阻断):${clip(err.stderr || err.message || "", 1500)}`;
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

    // 6. 修复循环(受 fixBudget 限制;每轮:AI 修复首个错误文件 → 重检)
    let attempts = 0;
    while (checkErrors.length > 0 && attempts < fixBudget) {
      await gate(ctrl);
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
        `自检未通过(fix 尝试 ${attempts}/${fixBudget} 次)。保留完整错误上下文:\n${checkErrors
          .map((e) => `${e.file}: ${e.message}`)
          .join("\n---\n")}`,
      );
    }

    await db.agentTask.update({
      where: { id: task.id },
      data: { status: "completed", finishedAt: new Date(), error: null },
    });
    await logActivity(
      projectId,
      "ai",
      `Agent 任务完成:${plan.title}`,
      `共 ${index} 步,修复 ${attempts} 次`,
    );

    // 8. 自动提交(稳定版本落 git,可随时回滚;取消不影响已完成的提交记录)
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isCancel = error instanceof TaskCancelled;
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
): void {
  const abort = new AbortController();
  const ctrl: TaskControl = { cancelled: false, paused: false, abort };
  controllers.set(task.id, ctrl);
  void runLoop(task, projectId, userId, message, maxSteps, ctrl);
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
    const staleMs = Date.now() - task.updatedAt.getTime();
    if (staleMs > 10 * 60 * 1000) {
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
