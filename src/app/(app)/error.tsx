"use client";

import { useEffect } from "react";

/** 应用区运行时错误兜底:展示友好错误并提供恢复操作,避免白屏。 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app] 页面渲染异常:", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] w-full flex-col items-center justify-center gap-4 px-4">
      <div className="text-center">
        <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">页面出错了</p>
        <p className="mt-2 max-w-md text-sm text-zinc-500 dark:text-zinc-400">
          渲染过程中发生异常
          {error.digest ? `(追踪码 ${error.digest.slice(0, 8)})` : ""}
          。可以尝试重新加载;若反复出现,请回到工作台再进入。
        </p>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-zinc-900"
        >
          重试
        </button>
        <a
          href="/dashboard"
          className="rounded-lg border border-zinc-200 px-4 py-2 text-sm text-zinc-600 transition-colors hover:border-zinc-300 dark:border-zinc-700 dark:text-zinc-400"
        >
          返回工作台
        </a>
      </div>
    </div>
  );
}
