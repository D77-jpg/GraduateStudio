"use client";

import { useActionState } from "react";
import Link from "next/link";
import { registerAction, type AuthFormState } from "../actions";

const initialState: AuthFormState = {};

export default function RegisterPage() {
  const [state, formAction, pending] = useActionState(registerAction, initialState);

  return (
    <div className="rounded-2xl border border-black/10 bg-white p-8 shadow-sm dark:border-white/10 dark:bg-zinc-900">
      <h1 className="text-xl font-semibold text-foreground">创建账号</h1>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        开始你的 AI 毕业设计之旅。
      </p>

      <form action={formAction} className="mt-6 space-y-4">
        <div>
          <label htmlFor="name" className="block text-sm font-medium text-foreground">
            昵称
          </label>
          <input
            id="name"
            name="name"
            type="text"
            required
            autoComplete="nickname"
            className="mt-1 w-full rounded-lg border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-zinc-400 dark:border-white/15"
            placeholder="怎么称呼你?"
          />
        </div>
        <div>
          <label htmlFor="email" className="block text-sm font-medium text-foreground">
            邮箱
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            className="mt-1 w-full rounded-lg border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-zinc-400 dark:border-white/15"
            placeholder="you@example.com"
          />
        </div>
        <div>
          <label htmlFor="password" className="block text-sm font-medium text-foreground">
            密码
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            autoComplete="new-password"
            className="mt-1 w-full rounded-lg border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-zinc-400 dark:border-white/15"
            placeholder="至少 8 位"
          />
        </div>

        {state.error ? (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950/50 dark:text-red-400">
            {state.error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {pending ? "创建中…" : "创建账号"}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
        已有账号?
        <Link href="/login" className="ml-1 font-medium text-foreground underline-offset-4 hover:underline">
          登录
        </Link>
      </p>
    </div>
  );
}
