import { z } from "zod";

/** 开发工作区共享类型(前后端)。 */

export const CHANGE_ACTIONS = ["create", "modify", "delete"] as const;
export type ChangeAction = (typeof CHANGE_ACTIONS)[number];

export const CHANGE_ACTION_LABELS: Record<ChangeAction, string> = {
  create: "新建",
  modify: "修改",
  delete: "删除",
};

export const CHANGESET_STATUSES = ["pending", "accepted", "rejected", "undone"] as const;
export type ChangeSetStatus = (typeof CHANGESET_STATUSES)[number];

export const CHANGESET_STATUS_LABELS: Record<ChangeSetStatus, string> = {
  pending: "待确认",
  accepted: "已应用",
  rejected: "已拒绝",
  undone: "已撤销",
};

export interface FileNodeDto {
  path: string;
  name: string;
  type: "file" | "dir";
}

export interface FileContentDto {
  path: string;
  content: string;
  truncated: boolean;
}

export interface SearchHitDto {
  path: string;
  line: number;
  text: string;
}

export interface SearchResultDto {
  query: string;
  totalMatches: number;
  truncated: boolean;
  hits: SearchHitDto[];
}

export interface ChangeDto {
  id: string;
  path: string;
  action: ChangeAction;
  beforeContent: string | null;
  afterContent: string | null;
}

export interface ChangeSetDto {
  id: string;
  projectId: string;
  title: string;
  summary: string;
  plan: Array<{ action: ChangeAction; path: string; reason?: string }>;
  source: string;
  status: ChangeSetStatus;
  createdAt: string;
  appliedAt: string | null;
  changes: ChangeDto[];
}

export interface ActivityLogDto {
  id: string;
  kind: "ai" | "terminal" | "file" | "system";
  message: string;
  detail: string;
  createdAt: string;
}

export interface TerminalRunDto {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  durationMs: number;
}

/** AI 实现阶段的输出 schema(供 agent 使用;路径校验在服务端执行)。 */
export const implementOutputSchema = z.object({
  notes: z.string().describe("实现说明,1-3 句话"),
  changes: z
    .array(
      z.object({
        action: z.enum(CHANGE_ACTIONS),
        path: z.string().min(1).max(200).describe("项目内相对路径,正斜杠"),
        content: z.string().describe("create/modify 时为修改后的完整文件内容;delete 时传空字符串"),
      }),
    )
    .min(1),
});

/** AI 计划阶段的输出 schema。 */
export const planOutputSchema = z.object({
  title: z.string().min(2).describe("任务标题"),
  summary: z.string().min(5).describe("方案说明,2-4 句"),
  steps: z
    .array(
      z.object({
        action: z.enum(CHANGE_ACTIONS),
        path: z.string().min(1).max(200).describe("项目内相对路径,正斜杠"),
        reason: z.string().describe("这一步做什么,一句话"),
      }),
    )
    .min(1),
  risks: z.string().describe("风险或注意事项,可为空字符串"),
});
