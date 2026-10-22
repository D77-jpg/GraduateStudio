/**
 * 用新交付闸门重放任意一个已有的 stage / 生成项目目录。
 *
 *   pnpm tsx scripts/replay-gate.ts <项目或stage目录> [--tier fast|full|auto] [--journal <journal.json>] [--out <report.json>]
 *
 * 典型用法：重放 2026-10-17 那次 full 任务保留的 stage，确认新闸门不再报 passed：
 *   pnpm tsx scripts/replay-gate.ts .agent-state/<projectId>/codex-tasks/<taskId>/stage \
 *     --journal .agent-state/<projectId>/codex-tasks/<taskId>/journal.json
 * （旧任务的 journal 是 v1 计划，没有可执行冒烟；此时只跑构建/测试与契约骨架冒烟。）
 *
 * 只在容器里执行项目命令；不会修改目标目录（闸门在临时副本上工作）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { runDeliveryGate, summarizeGate, type GateTier } from "../src/server/agents/delivery-gate";
import { validateCodexPlan, smokeScope } from "../src/server/agents/codex-plan";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const target = process.argv[2];
  if (!target || target.startsWith("--")) {
    console.error("用法：pnpm tsx scripts/replay-gate.ts <目录> [--tier fast|full|auto] [--journal <journal.json>] [--out <report.json>]");
    process.exit(2);
  }
  const stage = path.resolve(target);
  const tier = (arg("--tier") ?? "auto") as GateTier;
  let smoke;
  const journalPath = arg("--journal");
  if (journalPath) {
    try {
      const journal = JSON.parse(await fs.readFile(journalPath, "utf8")) as { plan?: { modules?: Array<{ featureIds: string[] }> } };
      if (journal.plan?.modules) {
        const featureIds = [...new Set(journal.plan.modules.flatMap((m) => m.featureIds))];
        const plan = validateCodexPlan(journal.plan, featureIds);
        smoke = smokeScope(plan, plan.modules.map((m) => m.id));
      }
    } catch (error) {
      console.warn(`journal 中的计划不可用于冒烟（${error instanceof Error ? error.message : error}），只执行构建/测试与契约骨架冒烟。`);
    }
  }
  const artifactsDir = path.resolve(arg("--artifacts") ?? path.join(process.cwd(), ".gate-replay", path.basename(stage)));
  console.log(`交付闸门重放：${stage}（tier=${tier}）`);
  const result = await runDeliveryGate(stage, { tier, smoke, artifactsDir, label: "replay" });
  for (const check of result.checks) {
    const mark = check.status === "passed" ? "✓" : check.status === "failed" ? "✗" : "■";
    console.log(`${mark} ${check.name.padEnd(36)} ${check.status}${check.cause ? `（${check.cause}）` : ""}${check.durationMs ? `  ${Math.round(check.durationMs / 1000)}s` : ""}`);
    if (check.status !== "passed") console.log(check.output.split("\n").slice(-15).map((l) => "    " + l).join("\n"));
  }
  console.log(`\n结果：${summarizeGate(result)}`);
  if (result.screenshots.length) console.log(`截图：\n${result.screenshots.join("\n")}`);
  const out = arg("--out") ?? path.join(artifactsDir, "gate-report.json");
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(result, null, 2), "utf8");
  console.log(`报告：${out}`);
  process.exit(result.status === "passed" ? 0 : 1);
}

void main();
