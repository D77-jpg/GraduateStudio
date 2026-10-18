import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db } from "@/server/db";
import { ensureProjectDir } from "@/server/workspace/paths";
import { safeCodexText } from "@/lib/codex-progress";
import type { AcceptanceCheck } from "@/lib/acceptance";
import { assertProjectOwner } from "./context";
import { loadCodexCheckpoint, saveCodexCheckpoint, type CodexCheckpoint } from "./codex-checkpoint";
import { acquireCodexProjectLease } from "./codex-lease";
import { inventoryWorkspace, assertInventoryUnchanged } from "./codex-assets";
import { prepareCodexDependencies } from "./codex-dependencies";
import { runCodexAcceptance, type CodexAcceptanceResult } from "./codex-acceptance";
import { verifyCodexPythonBackend } from "./codex-python-verification";
import { collectRuntimeRepairEvidence } from "../runtime/codex-runtime-diagnostics";
import { isRuntimeRepairRequest } from "./codex-repair-policy";

export interface CodexPostApplyReport {
  version: 1;
  status: "running" | "passed" | "failed" | "blocked";
  scope: "engineering_only";
  businessAcceptance: "pending";
  startedAt: string;
  finishedAt: string | null;
  cancelled: boolean;
  sourceUnchanged: boolean | null;
  sourceInventory?: Record<string, string>;
  dependencies?: Awaited<ReturnType<typeof prepareCodexDependencies>>;
  acceptance?: CodexAcceptanceResult;
  error?: string;
}
interface ActiveVerification {
  abort: AbortController;
  done?: Promise<void>;
}
const running = new Map<string, ActiveVerification>();
export function isCodexPostApplyVerificationRunning(taskId: string): boolean {
  return running.has(taskId);
}
/** Waits for the current verification lifecycle without cancelling or starting it. */
export async function awaitCodexPostApplyVerification(taskId: string): Promise<void> {
  await running.get(taskId)?.done;
}
/** Returns after isolated checks have settled and their owned temporary copy is removed. */
export async function cancelCodexPostApplyVerification(taskId: string): Promise<boolean> {
  const active = running.get(taskId);
  if (!active) return false;
  active.abort.abort();
  await active.done;
  return true;
}
function reportPath(cp: CodexCheckpoint) {
  return path.join(path.dirname(cp.stage), "post-apply-verification.json");
}
async function persist(cp: CodexCheckpoint, report: CodexPostApplyReport) {
  const target = reportPath(cp);
  const temp = path.join(path.dirname(target), `.post-apply-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, JSON.stringify(report), { flag: "wx", mode: 0o600 });
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
function stepReport(report: CodexPostApplyReport) {
  const checks: AcceptanceCheck[] = (report.acceptance?.checks ?? []).map((check, index) => ({
    id: `post-apply-${index}`,
    label: check.name,
    status: check.status === "not_run" ? "skipped" : check.status,
    command: check.command,
    output: check.output,
    durationMs: check.durationMs,
  }));
  if (report.dependencies && report.dependencies.status !== "passed")
    checks.unshift({
      id: "post-apply-dependencies",
      label: "隔离依赖准备",
      status: report.dependencies.status,
      output: report.dependencies.reason,
    });
  if (report.error)
    checks.push({
      id: "post-apply-error",
      label: "验证流程",
      status: report.status === "blocked" ? "blocked" : "failed",
      output: report.error,
    });
  return (
    "ACCEPTANCE_REPORT\n" +
    JSON.stringify({
      version: 1,
      status: report.status,
      checks,
      limitations: [
        "独立工程验证不代表业务功能或页面交互验收通过。",
        "支持的 Python 后端在隔离容器中执行依赖安装、源码编译与测试；缺少测试或执行证据时不视为通过。",
        "依赖可通过受控代理下载；项目检查在断网隔离容器的临时副本中执行，不运行模型或宿主机项目脚本。",
        "命令或耗时未记录时显示未知，不代表检查未执行。",
      ],
    })
  );
}
function sanitized<T>(value: T): T {
  // Reports contain bounded helper output; redact before persisting as well as displaying.
  if (typeof value === "string") return safeCodexText(value) as T;
  if (Array.isArray(value)) return value.map(sanitized) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitized(v)])) as T;
  return value;
}
/** Explicit POST/action only. No model calls, generated host scripts or project-file writes. */ export async function startCodexPostApplyVerification(
  projectId: string,
  taskId: string,
  userId: string,
): Promise<boolean> {
  // Authorize before returning a task's in-process state to another principal.
  await assertProjectOwner(projectId, userId);
  if (running.has(taskId)) return false;
  let settle!: () => void;
  const active: ActiveVerification = {
    abort: new AbortController(),
    done: new Promise<void>((resolve) => {
      settle = resolve;
    }),
  };
  running.set(taskId, active);
  let release: (() => Promise<void>) | undefined;
  let cp: CodexCheckpoint | null = null;
  let stepId: string | undefined;
  let report: CodexPostApplyReport | undefined;
  try {
    cp = await loadCodexCheckpoint(projectId, taskId);
    if (!cp || cp.phase !== "applied_unverified")
      throw new Error("只有已应用、尚未验收的 Codex 任务可以执行独立验证。");
    release = await acquireCodexProjectLease(cp.stage);
    // Lease may have waited behind a state transition; never validate a rejected/cancelled task.
    cp = await loadCodexCheckpoint(projectId, taskId);
    if (!cp || cp.phase !== "applied_unverified") throw new Error("任务状态已改变，无法启动验证。");
    active.abort.signal.throwIfAborted();
    const index = cp.nextStepIndex++;
    await saveCodexCheckpoint(cp);
    const step = await db.agentStep.create({
      data: {
        taskId,
        index,
        kind: "check",
        title: "应用后独立工程验证",
        status: "running",
        detail: "正在验证当前项目副本；不会运行模型或修改项目。",
      },
    });
    stepId = step.id;
    report = {
      version: 1,
      status: "running",
      scope: "engineering_only",
      businessAcceptance: "pending",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      cancelled: false,
      sourceUnchanged: null,
    };
    await persist(cp, report);
    await db.agentTask.update({
      where: { id: taskId },
      data: { status: "checking", error: null, finishedAt: null },
    });
    const checkpoint = cp,
      heldLease = release,
      currentReport = report,
      checkStepId = stepId;
    // All rejection paths are caught internally; callers do not need to retain a floating promise.
    void (async () => {
      let copy: string | undefined;
      try {
        active.abort.signal.throwIfAborted();
        const original = ensureProjectDir(projectId);
        const before = await inventoryWorkspace(original);
        currentReport.sourceInventory = before.hashes;
        await persist(checkpoint, currentReport);
        copy = await fs.mkdtemp(path.join(path.dirname(checkpoint.stage), "post-apply-copy-"));
        const copied = await inventoryWorkspace(original, copy);
        assertInventoryUnchanged(before, copied, "复制期间项目发生变化");
        assertInventoryUnchanged(
          before,
          await inventoryWorkspace(original),
          "复制期间项目发生变化",
        );
        active.abort.signal.throwIfAborted();
        currentReport.dependencies = sanitized(
          await prepareCodexDependencies(copy, active.abort.signal),
        );
        active.abort.signal.throwIfAborted();
        currentReport.acceptance = sanitized(await runCodexAcceptance(copy, active.abort.signal));
        active.abort.signal.throwIfAborted();
        // Python backends get real isolated dependency/test verification instead of a
        // blanket "unsupported" block. Absent Python roots contribute no checks.
        const python = sanitized(await verifyCodexPythonBackend(copy, active.abort.signal));
        if (python.checks.length) {
          // Python check names are already scoped, e.g. "server:python:tests".
          for (const check of python.checks) currentReport.acceptance.checks.push({ ...check });
          if (python.status === "failed") currentReport.acceptance.status = "failed";
          else if (python.status === "blocked" && currentReport.acceptance.status !== "failed")
            currentReport.acceptance.status = "blocked";
        }
        active.abort.signal.throwIfAborted();
        assertInventoryUnchanged(
          before,
          await inventoryWorkspace(original),
          "验证期间项目发生变化，报告已过期",
        );
        currentReport.sourceUnchanged = true;
        if (!currentReport.acceptance.checks.some((check) => check.status !== "not_run")) {
          currentReport.acceptance.status = "blocked";
          currentReport.acceptance.checks.push({
            name: "verification:coverage",
            status: "blocked",
            output: "没有可执行的独立工程检查，不能报告验证通过。",
          });
        }
        if (checkpoint.mode === "local" && isRuntimeRepairRequest(checkpoint.message)) {
          const observation = await collectRuntimeRepairEvidence(
            projectId,
            checkpoint.message,
            active.abort.signal,
          );
          if (observation) {
            await db.agentStep.create({
              data: {
                taskId,
                index: checkpoint.nextStepIndex++,
                kind: "note",
                title: "应用后运行故障复核：未重试模型",
                status: "done",
                detail: "RUNTIME_REPAIR_REPORT\n" + JSON.stringify(observation),
                finishedAt: new Date(),
              },
            });
            await saveCodexCheckpoint(checkpoint);
          }
        }
        const statuses = [currentReport.dependencies.status, currentReport.acceptance.status];
        currentReport.status = statuses.includes("failed")
          ? "failed"
          : statuses.includes("blocked")
            ? "blocked"
            : "passed";
      } catch (error) {
        currentReport.status = active.abort.signal.aborted ? "blocked" : "failed";
        currentReport.cancelled = active.abort.signal.aborted;
        currentReport.error = active.abort.signal.aborted
          ? "验证已取消；项目文件未被验证器修改。"
          : safeCodexText(String(error));
      } finally {
        // Never remove the model stage, actual project, or another verification's copy.
        if (copy) {
          try {
            await fs.rm(copy, { recursive: true, force: true });
          } catch {
            currentReport.status = "failed";
            currentReport.error = "验证临时副本清理失败，需检查任务存储。";
          }
        }
        currentReport.finishedAt = new Date().toISOString();
        try {
          await persist(checkpoint, currentReport);
        } catch {
          currentReport.status = "failed";
          currentReport.error = "验证报告保存失败，请重新验证。";
        }
        try {
          await db.agentStep.update({
            where: { id: checkStepId },
            data: {
              status:
                currentReport.status === "passed"
                  ? "done"
                  : currentReport.status === "blocked"
                    ? "skipped"
                    : "failed",
              detail: stepReport(currentReport),
              finishedAt: new Date(),
            },
          });
        } catch {
          /* task projection below still returns to paused */
        }
        try {
          checkpoint.error =
            currentReport.status === "passed"
              ? "独立工程验证通过；业务验收待完成。"
              : "独立工程验证未通过；请查看应用后验证报告。";
          await saveCodexCheckpoint(checkpoint).catch(() => {});
          await db.agentTask.update({
            where: { id: taskId },
            data: {
              status: "paused",
              error:
                currentReport.status === "passed"
                  ? "独立工程验证通过；业务功能仍待人工验收。"
                  : `独立工程验证${currentReport.status === "blocked" ? "受阻" : "失败"}；请查看验证报告。`,
              finishedAt: null,
            },
          });
        } finally {
          try {
            await heldLease();
          } finally {
            if (running.get(taskId) === active) running.delete(taskId);
          }
        }
      }
    })()
      .catch(() => {
        /* persistence/lease failure cannot become an unhandled rejection */
      })
      .finally(settle);
    return true;
  } catch (error) {
    if (report && cp) {
      report.status = "failed";
      report.finishedAt = new Date().toISOString();
      report.error = safeCodexText(String(error));
      await persist(cp, report).catch(() => {});
    }
    if (stepId)
      await db.agentStep
        .update({
          where: { id: stepId },
          data: { status: "failed", detail: "验证启动失败，请重试。", finishedAt: new Date() },
        })
        .catch(() => {});
    if (release) await release().catch(() => {});
    if (running.get(taskId) === active) running.delete(taskId);
    settle();
    throw error;
  }
}
