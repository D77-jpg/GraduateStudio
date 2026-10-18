import { buildRepairDiagnostics, compareRepairDiagnostics } from "./repair-diagnostics";
import type { AcceptanceReport } from "./acceptance";
import { planOutputSchema, implementOutputSchema } from "./develop";
import type { z } from "zod";
type PlanOutput = z.infer<typeof planOutputSchema>;

/** Block new obvious acceptance bypasses before creating a changeset; preserve existing originals. */
export function assertRepairChanges(
  changes: z.infer<typeof implementOutputSchema>["changes"],
  readOriginal: (path: string) => string,
): void {
  for (const change of changes) {
    if (change.action === "delete") throw new Error("自动修复不得删除文件以绕过验收。");
    const before = change.action === "modify" ? readOriginal(change.path) : "";
    if (/(?:^|\/)(?:tests?|__tests__)(?:\/|\.)|\.(?:test|spec)\./.test(change.path)) {
      const bypass = /\b(?:it|test|describe)\.(?:skip|todo|only)\s*\(/g;
      const count = (text: string) => (text.match(bypass) ?? []).length;
      if (count(change.content) > count(before))
        throw new Error(`修复新增跳过/独占测试：${change.path}，拒绝应用。`);
      const assertions = (text: string) =>
        (text.match(/\b(?:expect|assert(?:\.[A-Za-z]+)?)\s*\(/g) ?? []).length;
      if (assertions(change.content) < assertions(before))
        throw new Error(`修复减少测试断言：${change.path}，需人工核对，未应用。`);
    }
    if (change.path.endsWith("package.json")) {
      const previous = before ? JSON.parse(before) : {};
      const after = JSON.parse(change.content);
      for (const script of ["build", "test"]) {
        if (previous.scripts?.[script] && after.scripts?.[script] !== previous.scripts[script])
          throw new Error(`修复更改 ${change.path} 的 ${script} 验收脚本，需人工核对，未应用。`);
      }
    }
  }
}

/** Choose one failing check, prioritizing regressions and prerequisites, not an entire rewrite. */
export function selectRepairCheck(report: AcceptanceReport, previous?: AcceptanceReport): string {
  const current = buildRepairDiagnostics(report);
  const regressed = previous
    ? compareRepairDiagnostics(buildRepairDiagnostics(previous), current).regressedCheckIds
    : [];
  const rank = [
    "frontend-build",
    "backend-syntax",
    "backend-build",
    "backend-verify",
    "frontend-test",
    "backend-test",
    "backend-tests",
    "implementation-placeholders",
  ];
  const failed = report.checks.filter(
    (check) => check.status === "failed" || check.status === "blocked",
  );
  const candidates = failed.filter((check) => regressed.includes(check.id));
  return (
    [...(candidates.length ? candidates : failed)].sort((a, b) => {
      const priority = (id: string) => (rank.indexOf(id) < 0 ? rank.length : rank.indexOf(id));
      return priority(a.id) - priority(b.id);
    })[0]?.id ?? "implementation-placeholders"
  );
}

export function repairFocusPaths(report: AcceptanceReport, checkId: string): string[] {
  return [
    ...new Set(
      buildRepairDiagnostics(report)
        .issues.filter((issue) => issue.checkId === checkId)
        .flatMap((issue) => issue.paths),
    ),
  ];
}

export function focusedRepairPrompt(report: AcceptanceReport, checkId: string): string {
  const diagnostics = buildRepairDiagnostics(report);
  const issues = diagnostics.issues.filter((issue) => issue.checkId === checkId);
  const passed = report.checks
    .filter((check) => check.status === "passed")
    .map((check) => check.id);
  return `本轮仅修复检查 ${checkId} 的共同根因，不同时重写其他检查对应的模块。\n具体失败证据：${JSON.stringify(issues)}\n已通过且必须保持：${passed.join("、")}。\n${diagnostics.incompleteCheckIds.includes(checkId) ? `失败证据不完整：${diagnostics.incompleteReasons[checkId]}。本轮不得生成修复计划或修改文件。必须先重新获取完整失败断言/显式启动错误；源码阅读、通过数量、普通控制台错误均不能替代失败证据，也不得猜测缺依赖或改验收脚本。` : ""}\n先读取失败测试、目标实现与直接调用/导入方，明确字段/导出/路由契约，再做最小改动。修复理由必须对应上述失败。不要为了测试mock缺失而删除业务功能；可修复mock初始化，但不得删测试、skip/todo、弱化断言或提高超时掩盖挂起。不得重写整个package.json/构建配置来绕过业务失败；依赖缺失应保留原有脚本、依赖和插件，只补正确缺项。不要删除其他技术栈目录以绕过验收。计划只列必要文件，不改与本次失败无关的代码。完成后先定向检查，再全工程回归；定向通过不代表可交付。`;
}

/** No numerical file quota; reject a plan that escapes the failing subsystem before writes. */
export function assertFocusedRepairPlan(
  plan: Pick<PlanOutput, "steps">,
  checkId: string,
  evidencePaths: readonly string[],
): void {
  const prefixes = checkId.startsWith("frontend-")
    ? ["client/"]
    : checkId === "backend-test" || checkId === "backend-syntax" || checkId === "backend-build"
      ? ["backend/"]
      : checkId === "backend-tests" || checkId === "backend-verify"
        ? ["server/"]
        : [];
  for (const step of plan.steps) {
    if (step.action === "delete")
      throw new Error(`修复计划包含删除文件 ${step.path}，拒绝自动删除以防绕过验收。`);
    if (
      prefixes.length &&
      !prefixes.some((prefix) => step.path.startsWith(prefix)) &&
      !evidencePaths.includes(step.path)
    )
      throw new Error(`修复计划越过失败检查 ${checkId} 的范围：${step.path}，未应用本轮变更。`);
    if (!step.reason.trim()) throw new Error(`修复文件 ${step.path} 缺少根因说明。`);
  }
}
