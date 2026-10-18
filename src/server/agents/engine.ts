import type { ChildProcess } from "node:child_process";

export type AgentEngineId = "legacy" | "codex";
export type AgentEngineMode = "read-only" | "workspace-write";

export type AgentEngineEvent =
  | { type: "run.started"; runId: string; engine: AgentEngineId }
  | { type: "thread.started"; runId: string; threadId: string }
  | { type: "turn.started"; runId: string }
  | { type: "message.delta"; runId: string; text: string }
  | { type: "tool.started"; runId: string; item: unknown }
  | { type: "tool.completed"; runId: string; item: unknown }
  | { type: "error"; runId: string; message: string }
  | { type: "connection.retrying"; runId: string; message: string }
  | { type: "run.completed"; runId: string; exitCode: number }
  | { type: "run.failed"; runId: string; message: string; exitCode: number | null };

export interface AgentEngineTask {
  projectId: string;
  workspace: string;
  prompt: string;
  mode?: AgentEngineMode;
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  signal?: AbortSignal;
}

export interface AgentEngineResult {
  runId: string;
  engine: AgentEngineId;
  exitCode: number;
  threadId: string | null;
  lastMessage: string;
  changedPaths: string[];
  violations: string[];
}

export interface AgentEngine {
  readonly id: AgentEngineId;
  run(
    task: AgentEngineTask,
    onEvent?: (event: AgentEngineEvent) => void,
  ): Promise<AgentEngineResult>;
  cancel(runId: string): Promise<void>;
}

export type CodexSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal },
) => ChildProcess;
