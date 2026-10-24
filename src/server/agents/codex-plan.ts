import { z } from "zod";
import { smokeSpecSchema, hasWriteWithReadback, type SmokeSpec } from "./delivery-contract";

/**
 * v2：每个模块是一个“功能纵切”（迁移 + 接口 + 页面 + 测试），并携带平台会真实执行的
 * smoke 检查。acceptanceCriteria 保留为给人和模型看的说明，但“完成”只由 smoke + 交付闸门决定。
 * 计划在规划完成后冻结在 stage 之外的 journal.json，修复轮的模型无法放宽它。
 */
export const codexPlanSchema = z
  .object({
    version: z.literal(2),
    modules: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
            title: z.string().min(1).max(200),
            dependsOn: z.array(z.string()).max(100),
            featureIds: z.array(z.string()).max(1000),
            acceptanceCriteria: z.array(z.string().min(1).max(1000)).min(1).max(30),
            /** 纯查询/统计类模块可以没有写操作，但必须显式声明。 */
            readOnly: z.boolean().optional(),
            smoke: z.array(smokeSpecSchema).min(1).max(40),
          })
          .strict(),
      )
      .min(1)
      .max(60),
  })
  .strict();
export type CodexProjectPlan = z.infer<typeof codexPlanSchema>;
export type CodexPlanModule = CodexProjectPlan["modules"][number];

export function validateCodexPlan(raw: unknown, featureIds: string[]): CodexProjectPlan {
  if (raw && typeof raw === "object" && (raw as { version?: unknown }).version === 1)
    throw new Error("旧版（v1）模块计划没有可执行验收，已不再支持；请重新发起完整开发任务");
  const plan = codexPlanSchema.parse(raw);
  const remaining = new Map(plan.modules.map((m) => [m.id, m]));
  if (remaining.size !== plan.modules.length) throw new Error("模块 ID 重复");
  const knownFeatures = new Set(featureIds);
  const covered = new Set<string>();
  for (const m of plan.modules) {
    for (const id of m.featureIds) {
      if (!knownFeatures.has(id)) throw new Error(`未知需求功能：${id}`);
      covered.add(id);
    }
    for (const id of m.dependsOn) if (!remaining.has(id)) throw new Error(`未知模块依赖：${id}`);
    assertModuleSmoke(m);
  }
  for (const id of featureIds) if (!covered.has(id)) throw new Error(`完整规划缺少需求覆盖：${id}`);
  const ordered: typeof plan.modules = [];
  const done = new Set<string>();
  while (remaining.size) {
    const ready = [...remaining.values()].filter((m) => m.dependsOn.every((id) => done.has(id)));
    if (!ready.length) throw new Error("完整规划存在循环依赖");
    for (const m of ready) {
      ordered.push(m);
      done.add(m.id);
      remaining.delete(m.id);
    }
  }
  return { version: 2, modules: ordered };
}

function assertModuleSmoke(m: CodexPlanModule) {
  if (!m.featureIds.length) return;
  const http = m.smoke.filter((s) => s.kind === "http");
  const pages = m.smoke.filter((s) => s.kind === "page");
  if (!http.length) throw new Error(`模块 ${m.id} 缺少 HTTP 冒烟检查，无法验证接口真实可用`);
  if (!pages.length) throw new Error(`模块 ${m.id} 缺少页面冒烟检查，无法验证前端真实可用`);
  // 保存变量必须先定义后引用，否则检查一定失败，等于把错误留到运行期。
  const defined = new Set<string>();
  for (const step of m.smoke) {
    const text = JSON.stringify(step.kind === "http" ? [step.path, step.body] : [step.route]);
    for (const match of text.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g))
      if (match[1] !== "rand" && !defined.has(match[1]))
        throw new Error(`模块 ${m.id} 的冒烟检查引用了未定义变量 {{${match[1]}}}`);
    if (step.kind === "http") for (const name of Object.keys(step.saveAs ?? {})) defined.add(name);
  }
  if (!m.readOnly && !hasWriteWithReadback(m.smoke))
    throw new Error(
      `模块 ${m.id} 缺少“写入后用保存变量回读”的冒烟检查；纯查询模块请显式设置 readOnly: true`,
    );
}

/** 闸门回归范围：已完成模块 + 当前模块的 smoke 全部重跑，防止新模块破坏旧功能。 */
export function smokeScope(
  plan: CodexProjectPlan,
  moduleIds: string[],
): Array<{ moduleId: string; smoke: SmokeSpec[] }> {
  const wanted = new Set(moduleIds);
  return plan.modules
    .filter((m) => wanted.has(m.id))
    .map((m) => ({ moduleId: m.id, smoke: m.smoke }));
}
