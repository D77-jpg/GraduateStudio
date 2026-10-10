import { db } from "@/server/db";
import { getAiStatus } from "@/server/ai";
import { getWorkspaceRoot } from "@/server/workspace/paths";
import { PageHeader, SetPageTitle } from "@/components/layout/topbar";
import type { ReactNode } from "react";

function StatusRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-zinc-100 py-3 text-sm last:border-b-0 dark:border-zinc-800/80">
      <span className="shrink-0 text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className="truncate font-medium text-zinc-900 dark:text-zinc-100">{value}</span>
    </div>
  );
}

export default async function SettingsPage() {
  const ai = getAiStatus();

  let userCount: number | null = null;
  try {
    userCount = await db.user.count();
  } catch {
    userCount = null;
  }

  return (
    <>
      <SetPageTitle title="设置" />
      <div className="w-full px-4 py-8 lg:px-10">
        <PageHeader title="设置" description="运行环境状态(可编辑的设置界面将在后续阶段提供)。" />

        <div className="mt-8 max-w-2xl rounded-lg border border-zinc-200 px-6 py-2 dark:border-zinc-800">
          <StatusRow
            label="数据库"
            value={userCount === null ? "不可用" : `已连接(${userCount} 个用户)`}
          />
          <StatusRow
            label="AI Provider"
            value={
              ai.configured ? `${ai.provider} · ${ai.model}` : "未配置(请在 .env 中设置 API Key)"
            }
          />
          <StatusRow
            label="可用 Provider"
            value={ai.available.length > 0 ? ai.available.join("、") : "无"}
          />
          <StatusRow label="项目工作区" value={getWorkspaceRoot()} />
        </div>
      </div>
    </>
  );
}
