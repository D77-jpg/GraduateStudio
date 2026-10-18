import type { AgentEngine, AgentEngineId } from "../engine";

/** Engine selection is opt-in; legacy runner remains the default until Stage 1 wiring. */
export function createAgentEngine(id: AgentEngineId = "legacy"): AgentEngine | null {
  if (id === "codex")
    throw new Error(
      "旧 JSON 实现入口不支持 Codex。请使用局部或完整开发任务的隔离 Codex Worker；禁止回退宿主执行。",
    );
  return null;
}

export function configuredAgentEngine(): AgentEngine | null {
  return createAgentEngine(
    process.env.GRADUATESTUDIO_AGENT_ENGINE === "codex" ? "codex" : "legacy",
  );
}
