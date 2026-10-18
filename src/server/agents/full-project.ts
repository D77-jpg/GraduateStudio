import type { AgentTask } from "@prisma/client";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const execFileAsync = promisify(execFile);
import { db } from "@/server/db";
import { generateObjectCompat, type AiRequestEvent } from "@/server/ai/compat";
import {
  generationBatchKey,
  splitFailedGenerationBatch,
  isRecoverableGenerationFailure,
  generationFailureDiagnostic,
} from "@/lib/batch-recovery";
import { generatePlan, generateImplementation } from "./coding-agent";
import { assertProjectOwner, buildCodingContext, renderContextForPrompt } from "./context";
import { createPendingChangeSet, acceptChangeSet } from "@/server/changesets";
import { resolveProjectDir } from "@/server/workspace/paths";
import { fileExists, readFileContent } from "@/server/workspace/files";
import { listProjectFilePaths, isTextFilePath } from "@/server/workspace/search";
import {
  createGenerationBatches,
  generationBatchesForPlan,
  selectRelevantGenerationPaths,
  fullProjectModulePrompt,
} from "@/lib/generation-efficiency";
import { runProjectAcceptance } from "./acceptance";
import { repairEvidenceFromInvestigation } from "@/lib/investigation-repair";
import { investigateAcceptanceFailure } from "./investigation";
import { checkLocalDependencies, dependencyInstallEnvironment } from "./dependency-preparation";
import {
  buildRepairDiagnostics,
  compareRepairDiagnostics,
  hasCompleteRepairDiagnostics,
} from "@/lib/repair-diagnostics";
import { summarizeAcceptance, type AcceptanceReport } from "@/lib/acceptance";
import {
  selectRepairCheck,
  focusedRepairPrompt,
  repairFocusPaths,
  assertFocusedRepairPlan,
  assertRepairChanges,
} from "@/lib/repair-strategy";
import { detectSupportedGenerationStack } from "@/lib/stack-preflight";
import { assertGenerationPlan, assertImplementationCoverage } from "@/lib/generation-quality";
import {
  gate,
  registerTaskController,
  releaseTaskController,
  runStep,
  type TaskControl,
} from "./runner";
import {
  FULL_PROJECT_LIMITS,
  FULL_PROJECT_CHECKPOINT_PREFIX,
  fullProjectPlanSchema,
  orderFullProjectPlan,
  encodeFullProjectCheckpoint,
  parseFullProjectCheckpoint,
  consumedWallMs,
  fullProjectBatchTitle,
  canRepairFullProjectAcceptance,
  fullProjectAcceptanceFailureFingerprint,
  type FullProjectCheckpoint,
  type FullProjectModule,
} from "@/lib/full-project";

/** One parent task/controller. Durable state is only in AgentStep, never model-editable files. */
export function startFullProjectTask(
  task: AgentTask,
  projectId: string,
  userId: string,
  message = task.message,
  maxSteps = FULL_PROJECT_LIMITS.steps,
): boolean {
  const ctrl = registerTaskController(task.id, projectId);
  if (!ctrl) return false;
  void executeFullProjectTask(task, projectId, userId, message, maxSteps, ctrl);
  return true;
}

export async function resumeFullProjectTask(
  task: AgentTask,
  projectId: string,
  userId: string,
  _options?: { extendBudget?: boolean },
): Promise<boolean> {
  void _options; // Historical clients still send extendBudget; it no longer changes execution.
  if (projectId !== task.projectId) throw new Error("任务不属于当前项目");
  await assertProjectOwner(task.projectId, userId);
  const row = await db.agentStep.findFirst({
    where: { taskId: task.id, detail: { startsWith: FULL_PROJECT_CHECKPOINT_PREFIX } },
    orderBy: { index: "desc" },
  });
  const checkpoint = row && parseFullProjectCheckpoint(row.detail);
  if (
    !row ||
    !checkpoint ||
    checkpoint.taskId !== task.id ||
    checkpoint.projectId !== task.projectId
  )
    throw new Error("完整生成检查点不存在或损坏，不能安全恢复。");
  if (["completed", "cancelled"].includes(checkpoint.phase)) throw new Error("终态任务不能恢复。");
  const ctrl = registerTaskController(task.id, projectId);
  if (!ctrl) return false;
  try {
    void executeFullProjectTask(
      task,
      task.projectId,
      userId,
      checkpoint.message,
      checkpoint.maxSteps,
      ctrl,
      { id: row.id, checkpoint },
    );
    return true;
  } catch (error) {
    releaseTaskController(task.id);
    throw error;
  }
}

export async function executeFullProjectTask(
  task: AgentTask,
  projectId: string,
  userId: string,
  message: string,
  maxSteps: number,
  ctrl: TaskControl,
  resume?: { id: string; checkpoint: FullProjectCheckpoint },
): Promise<void> {
  let checkpoint = resume?.checkpoint;
  let resumeError = checkpoint?.error;
  let checkpointId = resume?.id;
  const save = async () => {
    if (!checkpoint || !checkpointId) return;
    checkpoint.updatedAt = new Date().toISOString();
    await db.agentStep.update({
      where: { id: checkpointId },
      data: { detail: encodeFullProjectCheckpoint(checkpoint) },
    });
  };
  try {
    await assertProjectOwner(projectId, userId);
    const requirement = await db.requirement.findUnique({
      where: { projectId },
      include: { features: { orderBy: { order: "asc" } } },
    });
    if (!requirement || !requirement.features.length)
      throw new Error("完整生成需要已有非空需求功能；请先完成需求分析，不能推断完整范围。");
    const scopeContext = await buildCodingContext(projectId, userId);
    const stack = detectSupportedGenerationStack(
      `${scopeContext.projectText}\n${scopeContext.architectureText}`,
    );
    if (!stack.supported) throw new Error(stack.reason);
    const scopeFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          requirement,
          requirementText: scopeContext.requirementText,
          projectText: scopeContext.projectText,
          architectureText: scopeContext.architectureText,
        }),
      )
      .digest("hex");
    if (!checkpoint) {
      // Checkpoint itself consumes the first persisted step.
      checkpoint = {
        version: 1,
        taskId: task.id,
        projectId,
        requirementId: requirement.id,
        requirementUpdatedAt: requirement.updatedAt.toISOString(),
        scopeFingerprint,
        featureIds: requirement.features.map((feature) => feature.id),
        message,
        phase: "planning",
        plan: null,
        completedModuleIds: [],
        currentModule: null,
        currentPlan: null,
        batchCursor: 0,
        pendingChangeSetId: null,
        appliedChangeSetIds: [],
        changedFiles: [],
        nextStepIndex: 1,
        modelCalls: 0,
        repairAttempts: 0,
        maxSteps: Math.max(1, maxSteps), // Legacy metadata, never an execution guard.
        elapsedMs: 0,
        activeSince: Date.now(),
        updatedAt: new Date().toISOString(),
        error: null,
        acceptanceReport: null,
      };
      const row = await db.agentStep.create({
        data: {
          taskId: task.id,
          index: 0,
          kind: "note",
          title: "完整项目生成检查点",
          status: "done",
          detail: encodeFullProjectCheckpoint(checkpoint),
          finishedAt: new Date(),
        },
      });
      checkpointId = row.id;
    } else {
      if (
        !checkpoint.scopeFingerprint ||
        checkpoint.scopeFingerprint !== scopeFingerprint ||
        checkpoint.requirementId !== requirement.id ||
        checkpoint.requirementUpdatedAt !== requirement.updatedAt.toISOString() ||
        checkpoint.featureIds.join() !== requirement.features.map((feature) => feature.id).join()
      )
        throw new Error("需求已变更；拒绝按旧范围恢复，请启动新任务。");
      // A crash leaves activeSince set: charge the entire interrupted interval conservatively.
      checkpoint.elapsedMs = consumedWallMs(checkpoint);
      checkpoint.activeSince = Date.now();
      const lastStep = await db.agentStep.findFirst({
        where: { taskId: task.id },
        orderBy: { index: "desc" },
      });
      checkpoint.nextStepIndex = Math.max(checkpoint.nextStepIndex, (lastStep?.index ?? 0) + 1);
      checkpoint.error = null;
      // Verify effective last-write content, including a crashed accepted current batch.
      const effective = new Map<string, string | null>();
      for (const id of [
        ...checkpoint.appliedChangeSetIds,
        ...(checkpoint.pendingChangeSetId ? [checkpoint.pendingChangeSetId] : []),
      ]) {
        const changeset = await db.changeSet.findFirst({
          where: { id, projectId },
          include: { changes: true },
        });
        if (!changeset || !["accepted", "pending"].includes(changeset.status))
          throw new Error("历史变更集丢失/已撤销，拒绝恢复。");
        if (changeset.status === "accepted")
          for (const change of changeset.changes)
            effective.set(change.path, change.action === "delete" ? null : change.afterContent);
        else
          for (const change of changeset.changes) {
            const current = fileExists(projectId, userId, change.path)
              ? readFileContent(projectId, userId, change.path).content
              : null;
            const after = change.action === "delete" ? null : change.afterContent;
            if (current !== change.beforeContent && current !== after)
              throw new Error(`恢复冲突：${change.path} 已被外部修改。`);
            effective.set(change.path, current);
          }
      }
      for (const [filePath, expected] of effective) {
        const current = fileExists(projectId, userId, filePath)
          ? readFileContent(projectId, userId, filePath).content
          : null;
        if (current !== expected)
          throw new Error(`恢复冲突：已完成模块文件 ${filePath} 已被外部修改。`);
      }
    }
    const cp = checkpoint;
    await save();
    await db.agentTask.update({
      where: { id: task.id },
      data: {
        status: "planning",
        startedAt: task.startedAt ?? new Date(),
        finishedAt: null,
        error: null,
      },
    });
    const boundary = async () => {
      await gate(ctrl);
      ctrl.abort.signal.throwIfAborted();
    };
    cp.executionStats ??= { modelMs: 0, modelCalls: 0, stepMs: 0, steps: 0 };
    let requestEvents = 0;
    const onRequestEvent = async (event: AiRequestEvent) => {
      requestEvents++;
      if (event.type === "started") {
        await boundary();
        cp.modelCalls++;
        cp.actualRequests = (cp.actualRequests ?? 0) + 1;
      }
      // Only the compat event's allowlisted metadata: never prompts, keys or endpoints.
      cp.lastRequest = { ...event, updatedAt: new Date().toISOString() };
      await save();
    };
    const model = async <T>(fn: () => Promise<T>): Promise<T> => {
      await boundary();
      const before = requestEvents;
      const started = Date.now();
      try {
        return await fn();
      } finally {
        // Older adapters/test mocks do not emit events; preserve their facade accounting.
        if (requestEvents === before) cp.modelCalls++;
        const stats = cp.executionStats!;
        stats.lastModelMs = Math.max(0, Date.now() - started);
        stats.modelMs += stats.lastModelMs;
        stats.modelCalls++;
        await save();
      }
    };
    const step = async <T>(
      kind: string,
      title: string,
      fn: (ctx: { setChangeSet: (id: string) => void }) => Promise<T>,
    ): Promise<T> => {
      await boundary();
      const index = cp.nextStepIndex++;
      await save();
      const started = Date.now();
      try {
        return await runStep({ ...task, maxSteps: cp.maxSteps }, index, kind, title, fn);
      } finally {
        const stats = cp.executionStats!;
        stats.lastStepMs = Math.max(0, Date.now() - started);
        stats.stepMs += stats.lastStepMs;
        stats.steps++;
        await save();
      }
    };
    if (!cp.plan) {
      await step("plan", "规划完整项目依赖有序模块与验收条件", async () => {
        const context = await buildCodingContext(projectId, userId, [], {
          autoSelectPlanningFiles: true,
        });
        const plan = await model(() =>
          generateObjectCompat({
            system:
              "你是完整项目工程规划器。只能覆盖已存储需求，禁止虚构完整范围、mock业务或省略功能。输出依赖有序、覆盖全部真实范围的工程模块，各模块验收条件可验证。",
            prompt: `${renderContextForPrompt(context)}\n用户目标：${message}\n已有需求功能（所有 ID 必须覆盖）：${JSON.stringify(requirement.features.map(({ id, parentId, name, description }) => ({ id, parentId, name, description })))}\n模块数量按完整需求范围决定，不设人为数量上限；必须包含 foundation/business/api/frontend/tests/config/docs 全部种类，可按需求分组业务模块。以依赖图确保共享基础与后端在前端之前，真实业务闭环优先于部署交付。foundation 仅共享基础设施和最小可启动配置，不提前实现未来业务；config 的部署交付配置与 docs 放在业务/API/前端之后，不把部署/config/docs 设为全部业务模块的前置根依赖。每模块 acceptanceCriteria 定义真实持久化、权限/校验、正常及失败路径等条件；测试/配置/文档覆盖构建、启动、业务测试及交付局限。不要把全部系统塞入一模块。`,
            schema: fullProjectPlanSchema,
            schemaName: "FullProjectPlan",
            onRequestEvent,
            signal: ctrl.abort.signal,
          }),
        );
        cp.plan = orderFullProjectPlan(plan, cp.featureIds);
        cp.phase = "modules";
        await save();
        await db.agentTask.update({
          where: { id: task.id },
          data: { title: `[完整生成] ${plan.title}` },
        });
        return JSON.stringify(cp.plan);
      });
    }
    const contextPaths = (currentPaths: string[] = []) =>
      selectRelevantGenerationPaths(
        listProjectFilePaths(projectId, userId).filter(isTextFilePath),
        currentPaths,
      );
    const existingLengths = (steps: NonNullable<FullProjectCheckpoint["currentPlan"]>["steps"]) => {
      const lengths: Record<string, number> = {};
      for (const file of steps)
        if (file.action === "modify") {
          // Read current originals for cost estimates; implementation still requires full originals.
          const original = readFileContent(projectId, userId, file.path);
          if (original.truncated) throw new Error(`待修改文件无法完整读取：${file.path}`);
          lengths[file.path] = original.content.length;
        }
      return lengths;
    };
    const runModule = async (workModule: FullProjectModule) => {
      cp.currentModule = workModule;
      await save();
      await db.agentTask.update({
        where: { id: task.id },
        data: { status: workModule.id.startsWith("repair-") ? "fixing" : "coding" },
      });
      const repairReport =
        workModule.id.startsWith("repair-") && cp.acceptanceReport
          ? (JSON.parse(cp.repairEvidenceReport ?? cp.acceptanceReport) as AcceptanceReport)
          : null;
      const focusId = repairReport
        ? (cp.repairFocusCheckId ?? selectRepairCheck(repairReport))
        : null;
      const focusPaths =
        repairReport && focusId
          ? [
              ...new Set([
                ...repairFocusPaths(repairReport, focusId),
                ...(cp.investigation?.checkId === focusId ? cp.investigation.paths : []),
              ]),
            ]
          : [];
      const moduleMessage =
        fullProjectModulePrompt(message, cp.plan, workModule, cp.completedModuleIds) +
        (repairReport && focusId ? `\n${focusedRepairPrompt(repairReport, focusId)}` : "") +
        (cp.investigation?.checkId === focusId
          ? `\n## 已完成的工具调查（必须依据证据最小修改）\n${cp.investigation.summary}`
          : "");
      // A historical plan-generation failure must not split a newly generated implementation plan.
      const resumingImplementation = cp.currentPlan !== null;
      if (!cp.currentPlan) {
        await step("plan", `模块计划：${workModule.title}`, async () => {
          const filePlan = await model(() =>
            generatePlan({
              projectId,
              userId,
              message: moduleMessage,
              selectedFilePaths: contextPaths(focusPaths),
              signal: ctrl.abort.signal,
              moduleScoped: true,
              onRequestEvent,
            }),
          );
          assertGenerationPlan(filePlan.steps);
          if (focusId) assertFocusedRepairPlan(filePlan, focusId, focusPaths);
          const batches = createGenerationBatches(filePlan.steps, existingLengths(filePlan.steps));
          // Publish the file-plan snapshot and boundaries together, before any implementation.
          cp.currentPlan = filePlan;
          cp.generationBatches = batches;
          cp.generationBatchKeys = batches.map(generationBatchKey);
          delete cp.batchRecovery;
          cp.batchCursor = 0;
          await save();
          return JSON.stringify(cp.currentPlan);
        });
      }
      const plan = cp.currentPlan;
      if (!plan) throw new Error("模块文件计划未持久化");
      let batches = generationBatchesForPlan(plan.steps, cp.generationBatches);
      const batchTitle = (cursor: number) =>
        cp.generationBatchKeys?.[cursor]
          ? `FULL_PROJECT_BATCH:${task.id}:${workModule.id}:${cp.generationBatchKeys[cursor]}`
          : fullProjectBatchTitle(task.id, workModule.id, cursor);
      if (
        resumingImplementation &&
        resumeError &&
        isRecoverableGenerationFailure(resumeError) &&
        !cp.pendingChangeSetId
      ) {
        const latest = await db.changeSet.findFirst({
          where: { projectId, title: batchTitle(cp.batchCursor) },
          orderBy: { createdAt: "desc" },
          include: { changes: true },
        });
        if (!latest || !["pending", "accepted"].includes(latest.status)) {
          if (splitFailedGenerationBatch(cp, workModule.id)) {
            await save();
            batches = generationBatchesForPlan(plan.steps, cp.generationBatches);
          }
          // A human-requested resume may make one bounded attempt for an unsplittable
          // slice (e.g. after fixing the service); automatic timeout handling still stops.
        }
      }
      resumeError = null;
      if (cp.batchCursor > batches.length)
        throw new Error("批次游标超出已持久化文件计划，拒绝恢复");
      for (; cp.batchCursor < batches.length;) {
        const cursor = cp.batchCursor;
        const steps = batches[cursor].map((index) => plan.steps[index]);
        const title = batchTitle(cursor);
        const splitRetry = new Error("SAFE_BATCH_SPLIT");
        try {
          await step("code", title, async ({ setChangeSet }) => {
            // Reconcile both pending and accepted records when the process died before saving the cursor.
            const existing = cp.pendingChangeSetId
              ? await db.changeSet.findFirst({
                  where: { id: cp.pendingChangeSetId, projectId },
                  include: { changes: true },
                })
              : await db.changeSet.findFirst({
                  where: { projectId, title },
                  orderBy: { createdAt: "desc" },
                  include: { changes: true },
                });
            let id = existing?.id;
            if (existing) {
              if (!["pending", "accepted"].includes(existing.status))
                throw new Error("批次变更集已撤销或拒绝，不能安全恢复。");
              for (const change of existing.changes) {
                const current = fileExists(projectId, userId, change.path)
                  ? readFileContent(projectId, userId, change.path).content
                  : null;
                const after = change.action === "delete" ? null : change.afterContent;
                if (
                  current !== after &&
                  (existing.status === "accepted" || current !== change.beforeContent)
                )
                  throw new Error(`恢复冲突：${change.path} 已被外部修改，停止以保护代码。`);
              }
            } else {
              let output: Awaited<ReturnType<typeof generateImplementation>>;
              try {
                output = await model(() =>
                  generateImplementation({
                    projectId,
                    userId,
                    message: `${moduleMessage}\n当前模块文件职责与契约快照：${JSON.stringify(plan.steps)}\n仅执行批次 ${cursor + 1}/${batches.length} 的 ${steps.length} 个文件；前 ${cursor} 批已应用，复用不重做。`,
                    plan: { ...plan, steps },
                    selectedFilePaths: contextPaths(steps.map((file) => file.path)),
                    signal: ctrl.abort.signal,
                    onRequestEvent,
                  }),
                );
              } catch (error) {
                // Only generation can trigger a split, never changeset creation/acceptance.
                if (
                  !ctrl.abort.signal.aborted &&
                  error instanceof Error &&
                  isRecoverableGenerationFailure(error)
                ) {
                  if (splitFailedGenerationBatch(cp, workModule.id)) {
                    await save();
                    throw splitRetry;
                  }
                  throw new Error(generationFailureDiagnostic(error, steps.length));
                }
                throw error;
              }
              assertImplementationCoverage(steps, output.changes);
              if (focusId)
                assertRepairChanges(output.changes, (file) => {
                  const original = readFileContent(projectId, userId, file);
                  if (original.truncated) throw new Error(`修复文件无法完整读取：${file}`);
                  return original.content;
                });
              await boundary();
              const pending = await createPendingChangeSet({
                projectId,
                userId,
                title,
                summary: output.notes,
                plan: steps,
                changes: output.changes,
              });
              id = pending.id;
            }
            if (!id) throw new Error("批次变更集不存在");
            cp.pendingChangeSetId = id;
            await save();
            // Set step linkage before acceptance, not merely after successful disk writes.
            setChangeSet(id);
            await db.agentStep.updateMany({
              where: { taskId: task.id, title, status: "running" },
              data: { changeSetId: id },
            });
            await boundary();
            const accepted =
              existing?.status === "accepted" ? existing : await acceptChangeSet(id, userId);
            if (!cp.appliedChangeSetIds.includes(id)) {
              cp.appliedChangeSetIds.push(id);
              cp.changedFiles.push(
                ...accepted.changes.map((change) => ({
                  path: change.path,
                  action: change.action as "create" | "modify" | "delete",
                })),
              );
            }
            cp.batchCursor++;
            cp.pendingChangeSetId = null;
            await save();
            return `已应用 ${accepted.changes.length} 个文件：${accepted.changes.map((change) => change.path).join("、")}`;
          });
        } catch (error) {
          if (error !== splitRetry) throw error;
          batches = generationBatchesForPlan(plan.steps, cp.generationBatches);
        }
      }
      if (!cp.completedModuleIds.includes(workModule.id)) cp.completedModuleIds.push(workModule.id);
      cp.currentModule = null;
      cp.currentPlan = null;
      delete cp.generationBatches;
      delete cp.generationBatchKeys;
      delete cp.batchRecovery;
      cp.batchCursor = 0;
      await save();
    };
    if (!cp.plan) throw new Error("完整模块计划未持久化");
    for (const workModule of cp.plan.modules) {
      if (!cp.completedModuleIds.includes(workModule.id)) {
        cp.phase = "modules";
        await runModule(workModule);
      }
    }
    // An interrupted repair is resumed using its persisted file plan, never regenerated from scratch.
    while (true) {
      const projectDir = resolveProjectDir(projectId);
      // Fixed commands only: dependency install must not execute generated lifecycle hooks.
      for (const relative of ["", "client", "backend", "server"]) {
        const cwd = path.join(projectDir, relative);
        if (!fs.existsSync(path.join(cwd, "package.json"))) continue;
        const dependencyFingerprint = () =>
          createHash("sha256")
            .update(
              ["package.json", "package-lock.json", "npm-shrinkwrap.json"]
                .map((name) =>
                  fs.existsSync(path.join(cwd, name))
                    ? fs.readFileSync(path.join(cwd, name), "utf8")
                    : "",
                )
                .join("\n"),
            )
            .digest("hex");
        const beforeInstall = dependencyFingerprint();
        if (
          cp.dependencyFingerprints?.[relative] === beforeInstall &&
          (await checkLocalDependencies(cwd)).ready
        )
          continue;
        await step("install", `安装依赖：${relative || "项目根目录"}`, async () => {
          const args = [
            "--ignore-scripts",
            "install",
            "--include=dev",
            "--no-audit",
            "--no-fund",
            "--loglevel",
            "error",
          ];
          const result = await execFileAsync(
            process.platform === "win32" ? "cmd.exe" : "npm",
            process.platform === "win32" ? ["/d", "/s", "/c", "npm " + args.join(" ")] : args,
            {
              cwd,
              timeout: 600_000,
              windowsHide: true,
              maxBuffer: 2 * 1024 * 1024,
              signal: ctrl.abort.signal,
              env: dependencyInstallEnvironment(),
            },
          );
          const readiness = await checkLocalDependencies(cwd);
          if (!readiness.ready)
            throw new Error(
              `依赖安装后仍未就绪：${relative || "项目根目录"}；${readiness.reason}。停止代码修复，不能使用宿主工程依赖代替。`,
            );
          cp.dependencyFingerprints ??= {};
          cp.dependencyFingerprints[relative] = dependencyFingerprint();
          await save();
          return (result.stdout || result.stderr || "依赖安装完成").slice(0, 8000);
        });
      }
      if (cp.currentModule?.id.startsWith("repair-")) {
        const dependencyFailure =
          cp.acceptanceReport &&
          /(?:VUE_PLUGIN_UNAVAILABLE|Cannot find (?:module|package)|无法加载 Vue 插件)/.test(
            cp.acceptanceReport,
          );
        const unsupportedPlan =
          cp.acceptanceReport &&
          cp.repairFocusCheckId &&
          !hasCompleteRepairDiagnostics(
            buildRepairDiagnostics(JSON.parse(cp.acceptanceReport)),
            cp.repairFocusCheckId,
          );
        if (
          ((dependencyFailure && cp.batchCursor > 0) ||
            (unsupportedPlan && cp.currentPlan?.summary.includes("failure details unavailable")) ||
            cp.currentPlan?.summary.includes("failure details unavailable")) &&
          resumeError?.includes("验收脚本") &&
          cp.currentPlan &&
          !cp.pendingChangeSetId
        ) {
          // The applied prefix stays recorded; dependency readiness supersedes only an unapplied suffix.
          await step(
            "diagnostic",
            "依赖环境重新就绪",
            async () =>
              "已验证本地依赖，不继续增加构建前置自动安装脚本；保留已应用变更，先重新进行真实验收。",
          );
          cp.currentModule = null;
          cp.currentPlan = null;
          delete cp.generationBatches;
          delete cp.generationBatchKeys;
          delete cp.batchRecovery;
          cp.batchCursor = 0;
          await save();
        } else await runModule(cp.currentModule);
      }
      if (cp.repairFocusCheckId && cp.repairBaselineReport) {
        const focus = cp.repairFocusCheckId;
        const baseline = JSON.parse(cp.repairBaselineReport) as AcceptanceReport;
        const targeted = await step("check", `定向验收：${focus}`, () =>
          runProjectAcceptance(projectDir, { signal: ctrl.abort.signal, onlyCheckIds: [focus] }),
        );
        await db.agentStep.updateMany({
          where: { taskId: task.id, index: cp.nextStepIndex - 1 },
          data: { detail: `ACCEPTANCE_REPORT\n${JSON.stringify(targeted)}` },
        });
        if (targeted.status !== "passed") {
          const priorFocus = {
            ...baseline,
            checks: baseline.checks.filter((check) => check.id === focus),
          };
          const comparison = compareRepairDiagnostics(
            buildRepairDiagnostics(priorFocus),
            buildRepairDiagnostics(targeted),
          );
          if (comparison.stalled) {
            cp.acceptanceReport = JSON.stringify({
              ...baseline,
              checks: baseline.checks.map(
                (check) => targeted.checks.find((updated) => updated.id === check.id) ?? check,
              ),
            });
            await save();
            throw new Error(
              `定向修复未取得进展：${focus} 的具体失败再次出现。已保留变更和断点，不继续相同修复；请查看失败用例根因。\n${JSON.stringify(targeted)}`,
            );
          }
        }
      }
      cp.phase = "acceptance";
      await save();
      await db.agentTask.update({ where: { id: task.id }, data: { status: "checking" } });
      const baselineReport = cp.repairBaselineReport
        ? (JSON.parse(cp.repairBaselineReport) as AcceptanceReport)
        : null;
      let report = await step("check", "完整项目工程验收：构建、测试与占位检查", async () => {
        const report = await runProjectAcceptance(resolveProjectDir(projectId), {
          signal: ctrl.abort.signal,
        });
        cp.acceptanceReport = JSON.stringify(report);
        await save();
        return report;
      });
      // Keep the established UI report contract on the check step.
      await db.agentStep.updateMany({
        where: { taskId: task.id, index: cp.nextStepIndex - 1 },
        data: { detail: `ACCEPTANCE_REPORT\n${JSON.stringify(report)}` },
      });
      await boundary();
      if (report.status === "passed") break;
      const missingEvidence = buildRepairDiagnostics(report).incompleteCheckIds;
      if (missingEvidence.length && canRepairFullProjectAcceptance(report)) {
        const recovered = await step("check", "自动补采失败证据", () =>
          runProjectAcceptance(projectDir, {
            signal: ctrl.abort.signal,
            onlyCheckIds: [...new Set(missingEvidence)],
          }),
        );
        report = {
          ...report,
          checks: report.checks.map(
            (check) => recovered.checks.find((updated) => updated.id === check.id) ?? check,
          ),
        };
        report.status = summarizeAcceptance(report.checks);
        cp.acceptanceReport = JSON.stringify(report);
        await save();
        await db.agentStep.updateMany({
          where: { taskId: task.id, index: cp.nextStepIndex - 1 },
          data: { detail: `ACCEPTANCE_REPORT\n${JSON.stringify(recovered)}` },
        });
        if (report.status === "passed") break;
      }
      const investigate = async (focusId: string) => {
        const result = await step("diagnostic", `工程工具调查：${focusId}`, () =>
          model(() =>
            investigateAcceptanceFailure({
              projectDir,
              report,
              focusId,
              signal: ctrl.abort.signal,
              onRequestEvent,
              onObservation: async (observation, hypothesis) => {
                await step("diagnostic", `调查工具：${observation.request.tool}`, async () =>
                  JSON.stringify({ hypothesis, ...observation }),
                );
              },
            }),
          ),
        );
        cp.investigation = {
          checkId: focusId,
          disposition: result.disposition,
          summary: result.summary,
          paths: result.paths,
        };
        await save();
        await step("diagnostic", "工程调查结论", async () => JSON.stringify(cp.investigation));
        return result;
      };
      let groundedInvestigation:
        Awaited<ReturnType<typeof investigateAcceptanceFailure>> | undefined;
      if (!canRepairFullProjectAcceptance(report)) {
        const focus = selectRepairCheck(report);
        groundedInvestigation = await investigate(focus);
        const repairEvidence = repairEvidenceFromInvestigation(
          report,
          focus,
          groundedInvestigation,
        );
        if (repairEvidence) {
          // Keep the actual timeout in the UI report; use single-test evidence only for scoped repair.
          report = repairEvidence;
          cp.repairBaselineReport = undefined;
          await step(
            "diagnostic",
            "单测试已复现代码失败，继续最小修复",
            async () =>
              "完整验收仍未通过；已取得完整单测试失败证据，允许修复该根因。修复后仍须执行原完整验收。",
          );
        } else
          throw new Error(
            `工程验收${report.status === "blocked" ? "受阻" : "未通过"}；存在不可自动修复的问题，不能标记完成。\n${report.checks
              .filter((check) => check.status === "blocked")
              .map((check) => `${check.label}：${check.output.split("\n")[0]}`)
              .join("\n")}\n完整报告保留在验收记录。`,
          );
      }
      if (baselineReport && !groundedInvestigation) {
        const comparison = compareRepairDiagnostics(
          buildRepairDiagnostics(baselineReport),
          buildRepairDiagnostics(report),
        );
        await step(
          "diagnostic",
          "修复效果对比",
          async () =>
            `已消除 ${comparison.resolvedIds.length} 项具体失败；仍存在 ${comparison.persistentIds.length} 项；新增 ${comparison.newIds.length} 项。${comparison.regressedCheckIds.length ? `此前通过的检查回退：${comparison.regressedCheckIds.join("、")}。` : ""}`,
        );
        if (comparison.regressedCheckIds.length)
          throw new Error(
            `本轮修复造成已通过检查回退：${comparison.regressedCheckIds.join("、")}。已停止叠加修复；变更仍保留供核对，不自动回滚覆盖用户文件。`,
          );
        if (comparison.stalled)
          throw new Error(
            "具体失败用例未减少，修复未收敛。已停止重复生成；请查看修复效果对比和验收报告定位根因。",
          );
      }
      const failureFingerprint = fullProjectAcceptanceFailureFingerprint(report);
      if (cp.repairFailureFingerprint === failureFingerprint)
        throw new Error(
          `工程验收未通过；已尝试修复但相同的规范化失败报告再次出现，未取得进展，停止重复修复以保护项目。不能标记完成。\n${cp.acceptanceReport}`,
        );
      cp.repairFailureFingerprint = failureFingerprint;
      cp.repairFocusCheckId = selectRepairCheck(report, baselineReport ?? undefined);
      if (!hasCompleteRepairDiagnostics(buildRepairDiagnostics(report), cp.repairFocusCheckId))
        throw new Error(
          `检查 ${cp.repairFocusCheckId} 缺少完整失败证据，停止猜测性代码修复。请获取具名失败/启动错误后继续；不会自动改验收入口。`,
        );
      const investigation = groundedInvestigation ?? (await investigate(cp.repairFocusCheckId));
      cp.repairEvidenceReport = JSON.stringify(report);
      if (investigation.disposition !== "repair")
        throw new Error(
          `工程工具调查${investigation.disposition === "environment" ? "发现环境阻塞" : "尚未证实根因"}：${investigation.summary}\n保留观察和断点，未执行猜测性代码修复。`,
        );
      cp.repairBaselineReport = JSON.stringify(report);
      cp.repairAttempts++;
      cp.phase = "repair";
      const repair: FullProjectModule = {
        id: `repair-${cp.repairAttempts}`,
        title: `验收修复 ${cp.repairAttempts}`,
        kind: "tests",
        featureIds: [],
        dependsOn: [],
        objective: "仅基于真实失败报告修复根因，不删除测试/降低验收门槛，不引入假数据。",
        acceptanceCriteria: ["保留原需求业务闭环，消除报告中的失败并重新进行真实全工程验收"],
      };
      cp.currentModule = repair;
      await save();
      await db.agentTask.update({
        where: { id: task.id },
        data: { fixAttempts: cp.repairAttempts },
      });
      await runModule(repair);
    }
    await boundary();
    cp.phase = "completed";
    cp.error = null;
    await save();
    await boundary();
    await db.agentTask.update({
      where: { id: task.id },
      data: { status: "completed", error: null, finishedAt: new Date() },
    });
    // Engineering acceptance is not a claim of complete business/manual delivery. No automatic commits.
  } catch (error) {
    const cancelled = ctrl.cancelled;
    const detail = error instanceof Error ? error.message : String(error);
    if (checkpoint) {
      checkpoint.phase = cancelled ? "cancelled" : "blocked";
      checkpoint.error = detail;
      await save();
    }
    await db.agentTask.update({
      where: { id: task.id },
      data: {
        status: cancelled ? "cancelled" : "failed",
        error: detail.slice(0, 6000),
        finishedAt: new Date(),
      },
    });
  } finally {
    if (checkpoint) {
      checkpoint.elapsedMs = consumedWallMs(checkpoint);
      checkpoint.activeSince = null;
      await save().finally(() => releaseTaskController(task.id));
    } else releaseTaskController(task.id);
  }
}
