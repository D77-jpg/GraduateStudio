import { z } from "zod";

export const codexPlanSchema = z
  .object({
    version: z.literal(1),
    modules: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
            title: z.string().min(1).max(200),
            dependsOn: z.array(z.string()).max(100),
            featureIds: z.array(z.string()).max(1000),
            acceptanceCriteria: z.array(z.string().min(1).max(1000)).min(1).max(30),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type CodexProjectPlan = z.infer<typeof codexPlanSchema>;
export function validateCodexPlan(raw: unknown, featureIds: string[]): CodexProjectPlan {
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
  return { version: 1, modules: ordered };
}
