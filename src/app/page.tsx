import Link from "next/link";
import { auth } from "@/server/auth";

const FLOW = [
  "选题",
  "需求分析",
  "架构设计",
  "UI 设计",
  "数据库",
  "AI 开发",
  "运行预览",
  "自动测试",
  "自动修复",
  "部署",
  "论文",
  "答辩",
] as const;

export default async function LandingPage() {
  const session = await auth();

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4">
        <span className="text-sm font-semibold tracking-tight text-foreground">
          GraduateStudio
        </span>
        <nav className="flex items-center gap-3 text-sm">
          {session?.user ? (
            <Link
              href="/dashboard"
              className="rounded-lg bg-zinc-900 px-4 py-2 font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              进入工作台
            </Link>
          ) : (
            <>
              <Link
                href="/login"
                className="px-3 py-2 text-zinc-600 transition-colors hover:text-foreground dark:text-zinc-300"
              >
                登录
              </Link>
              <Link
                href="/register"
                className="rounded-lg bg-zinc-900 px-4 py-2 font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                开始创建
              </Link>
            </>
          )}
        </nav>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col items-center justify-center px-4 py-20 text-center">
        <h1 className="max-w-3xl text-4xl font-semibold leading-tight tracking-tight text-foreground sm:text-5xl">
          Build Your Graduation Project
          <span className="block text-zinc-400 dark:text-zinc-500">With AI.</span>
        </h1>
        <p className="mt-6 max-w-xl text-base leading-relaxed text-zinc-500 dark:text-zinc-400">
          从一个想法,到一个完整的毕业设计。AI Agent
          协助你完成选题、需求、架构、开发、测试、部署、论文与答辩。
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href={session?.user ? "/dashboard" : "/register"}
            className="rounded-xl bg-zinc-900 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {session?.user ? "继续开发" : "开始创建项目"}
          </Link>
          <Link
            href="/login"
            className="rounded-xl border border-black/10 px-6 py-3 text-sm font-medium text-foreground transition-colors hover:bg-zinc-100 dark:border-white/15 dark:hover:bg-zinc-800"
          >
            查看示例项目
          </Link>
        </div>

        <ul className="mt-16 flex max-w-4xl flex-wrap items-center justify-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
          {FLOW.map((step, index) => (
            <li key={step} className="flex items-center gap-2">
              {index > 0 ? <span className="text-zinc-300 dark:text-zinc-600">→</span> : null}
              <span className="rounded-full border border-black/10 px-3 py-1 dark:border-white/10">
                {step}
              </span>
            </li>
          ))}
        </ul>
      </main>

      <footer className="py-8 text-center text-xs text-zinc-400 dark:text-zinc-600">
        GraduateStudio · AI Graduation Project Operating System · Phase 0 基础工程
      </footer>
    </div>
  );
}
