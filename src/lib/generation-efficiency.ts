import type { ChangeAction } from "./develop";
import type { FullProjectModule, FullProjectPlan } from "./full-project";
import { assertGenerationPlan, prioritizePlanningFiles } from "./generation-quality";

export const GENERATION_BATCH_CHARS = 24_000;
export const GENERATION_BATCH_FILES = 6;
const LARGE_FILE_CHARS = 12_000;
type PlannedFile = { path: string; action: ChangeAction; reason?: string };

/** Estimates affect batching only, never permit clipped originals or partial output. */
export function estimateGenerationChars(step: PlannedFile, existingChars?: number): number {
  if (step.action === "delete") return 160;
  const base = /\.(?:java|vue|tsx)$/i.test(step.path)
    ? 6_000
    : /\.(?:json|ya?ml|md|properties|xml)$/i.test(step.path)
      ? 2_000
      : 4_000;
  return step.action === "modify" && existingChars !== undefined
    ? Math.max(base, Math.ceil(existingChars * 1.25) + 1_000)
    : base;
}

/** Contiguous step indices preserve dependency order. Oversized files always run alone. */
export function createGenerationBatches(
  steps: readonly PlannedFile[],
  existingLengths: Readonly<Record<string, number>> = {},
): number[][] {
  assertGenerationPlan(steps);
  const batches: number[][] = [];
  let batch: number[] = [];
  let chars = 0;
  const flush = () => {
    if (batch.length) batches.push(batch);
    batch = [];
    chars = 0;
  };
  steps.forEach((step, index) => {
    const cost = estimateGenerationChars(step, existingLengths[step.path]);
    if (cost >= LARGE_FILE_CHARS) {
      flush();
      batches.push([index]);
      return;
    }
    if (batch.length >= GENERATION_BATCH_FILES || chars + cost > GENERATION_BATCH_CHARS) flush();
    batch.push(index);
    chars += cost;
  });
  flush();
  return batches;
}

/** Missing boundaries mean an unfinished legacy checkpoint: do not re-partition its cursor. */
export function generationBatchesForPlan(
  steps: readonly PlannedFile[],
  persisted?: readonly (readonly number[])[],
): number[][] {
  if (persisted !== undefined) {
    const indices = persisted.flat();
    if (
      persisted.some((batch) => !batch.length || batch.length > GENERATION_BATCH_FILES) ||
      indices.length !== steps.length ||
      indices.some((index, offset) => index !== offset)
    ) {
      throw new Error("生成批次检查点损坏，拒绝重排未完成计划");
    }
    return persisted.map((batch) => [...batch]);
  }
  // Legacy checkpoints without persisted boundaries retain their historical
  // two-step cursor semantics; only the ordinary runner uses size-aware batches.
  return Array.from({ length: Math.ceil(steps.length / 2) }, (_, index) =>
    Array.from(
      { length: Math.min(2, steps.length - index * 2) },
      (_, offset) => index * 2 + offset,
    ),
  );
}

export function implementationOutputTokens(
  steps: readonly PlannedFile[],
  existingLengths: Readonly<Record<string, number>> = {},
): number {
  const chars = steps.reduce(
    (total, step) => total + estimateGenerationChars(step, existingLengths[step.path]),
    0,
  );
  return Math.min(20_000, Math.max(12_000, steps.length * 3_000, Math.ceil(chars / 2) + 2_000));
}

/** Current targets, nearby contracts and shared entries outrank unrelated historical writes. */
export function selectRelevantGenerationPaths(
  allPaths: readonly string[],
  currentPaths: readonly string[],
  limit = 24,
): string[] {
  const targets = new Set(currentPaths);
  const dirs = currentPaths.map((p) => p.slice(0, p.lastIndexOf("/") + 1)).filter(Boolean);
  const words = new Set(
    currentPaths
      .flatMap((p) =>
        p
          .replace(/([a-z])([A-Z])/g, "$1 $2")
          .toLowerCase()
          .split(/[^a-z0-9]+/),
      )
      .filter(
        (word) =>
          word.length > 3 &&
          !["client", "server", "index", "main", "controller", "service"].includes(word),
      ),
  );
  const prioritized = prioritizePlanningFiles(allPaths);
  const score = (p: string) => {
    if (targets.has(p)) return 100;
    const tokens = p.toLowerCase().split(/[^a-z0-9]+/);
    const related = tokens.some((word) => words.has(word));
    if (related) return 80;
    if (dirs.some((dir) => p.startsWith(dir))) return 70;
    if (
      /(^|\/)(package\.json|pom\.xml|schema\.prisma|[^/]*config[^/]*|application\.[^/]+|main\.[^/]+|app\.[^/]+|index\.[^/]+|[^/]*Application\.java)$/i.test(
        p,
      )
    )
      return 60;
    if (/(^|\/)(api|routes|controllers|contracts|models|auth)\//i.test(p)) return 40;
    return 0;
  };
  return [...new Set([...currentPaths, ...prioritized])]
    .map((p, order) => ({ p, order, score: score(p) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map((item) => item.p);
}

export function fullProjectModulePrompt(
  message: string,
  plan: FullProjectPlan | null,
  current: FullProjectModule,
  completedIds: readonly string[],
): string {
  const summary = plan?.modules.map(({ id, kind, dependsOn, objective }) => ({
    id,
    kind,
    dependsOn,
    objective,
    status: completedIds.includes(id) ? "已满足，复用不重做" : "待实现",
  }));
  return `${message}\n模块职责/依赖摘要：${JSON.stringify(summary)}\n当前模块（仅实现这些职责与验收条件）：${JSON.stringify(current)}\n依赖模块已有文件是既有契约和文件所有权依据；复用其 API 路径、方法、权限、请求/响应、schema 与导出，不重新实现已满足工作。当前文件计划明确各文件所有权与接口契约；其他模块的实现留给其负责人。\n${current.kind === "foundation" ? "基础模块仅共享基础设施、入口、数据库连接、通用鉴权/错误处理与必要共享契约；禁止提前实现未来模块的业务服务、业务 API、业务页面或全部业务测试。" : "只实现当前模块，与已有文件/接口对齐，不扩大模块范围。"}\n模块中间不要执行全工程验收或重复部署说明；构建/启动/部署文档由最终 config/docs 模块负责，真实全工程验收在所有模块结束后执行。`;
}
