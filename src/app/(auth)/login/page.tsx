"use client";

import { useActionState } from "react";
import Link from "next/link";
import { loginAction, type AuthFormState } from "../actions";

const initialState: AuthFormState = {};

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, initialState);

  return (
    <div className="rounded-2xl border border-black/10 bg-white p-8 shadow-sm dark:border-white/10 dark:bg-neutral-900">
      <h1 className="text-xl font-semibold text-foreground">登录 GraduateStudio</h1>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        从一个想法,到一个完整的毕业设计。
      </p>

      <form action={formAction} className="mt-6 space-y-4">
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
            className="mt-1 w-full rounded-lg border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-400 dark:border-white/15"
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
            autoComplete="current-password"
            className="mt-1 w-full rounded-lg border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-400 dark:border-white/15"
            placeholder="••••••••"
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
          className="w-full rounded-lg bg-neutral-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {pending ? "登录中…" : "登录"}
        </button>
      </form>

      <div className="mt-4 rounded-lg bg-neutral-50 px-3 py-2 text-xs text-neutral-500 dark:bg-neutral-800/60 dark:text-neutral-400">
        演示账号:demo@graduatestudio.dev / demo1234
      </div>

      <p className="mt-6 text-center text-sm text-neutral-500 dark:text-neutral-400">
        还没有账号?
        <Link href="/register" className="ml-1 font-medium text-foreground underline-offset-4 hover:underline">
          注册
        </Link>
      </p>
    </div>
  );
}
