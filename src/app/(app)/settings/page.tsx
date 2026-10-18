import { db } from "@/server/db";
import { getAiStatus } from "@/server/ai";
import { PageHeader, SetPageTitle } from "@/components/layout/topbar";
import { ModelConfig } from "@/components/features/settings/model-config";
import type { ReactNode } from "react";

function StatusRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 border-b border-zinc-100 py-4 text-sm last:border-b-0 dark:border-zinc-800/80">
      <span className="shrink-0 text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className="min-w-0 break-words font-medium text-zinc-900 dark:text-zinc-100">
        {value}
      </span>
    </div>
  );
}

export default async function SettingsPage() {
  const ai = getAiStatus();

  let databaseConnected = false;
  try {
    await db.$queryRaw`SELECT 1`;
    databaseConnected = true;
  } catch {
    databaseConnected = false;
  }

  return (
    <>
      <SetPageTitle title="设置" />
      <div className="w-full px-4 py-8 lg:px-10">
        <PageHeader
          title="设置"
          description="管理 AI 模型配置，查看项目保存与辅助创作的服务状态。"
        />

        <div className="mt-8 max-w-3xl space-y-6">
          <ModelConfig />

          <section className="rounded-2xl border border-zinc-200 bg-white px-6 py-5 dark:border-zinc-800 dark:bg-zinc-900/40">
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">服务状态</h2>
            <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
              项目资料保存到数据库，AI
              服务用于辅助选题、分析与创作。以下信息为只读状态，由平台统一管理。
            </p>
            <div className="mt-4">
              <StatusRow label="项目数据库" value={databaseConnected ? "已连接" : "暂时无法连接"} />
              <StatusRow label="AI 服务" value={ai.configured ? "已配置" : "暂未配置"} />
              <StatusRow label="当前服务商" value={ai.provider ?? "暂无"} />
              <StatusRow label="当前模型" value={ai.model ?? "暂无"} />
              <StatusRow
                label="已配置服务商"
                value={ai.available.length > 0 ? ai.available.join("、") : "暂无"}
              />
            </div>
            <p className="mt-4 rounded-xl bg-zinc-50 px-4 py-3 text-xs leading-5 text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400">
              AI
              状态反映平台当前配置，不代表实时连接测试。实际请求仍可能受到网络、服务商额度或模型访问权限的影响。
              {!ai.configured ? " AI 服务未配置时，你仍可手动创建项目并编辑项目资料。" : ""}
            </p>
          </section>
        </div>
      </div>
    </>
  );
}
