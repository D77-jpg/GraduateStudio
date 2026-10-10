"use client";

import { useActionState } from "react";
import Link from "next/link";
import { loginAction, type AuthFormState } from "../actions";

const initialState: AuthFormState = {};

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, initialState);

  return (
    <div className="rounded-[28px] border border-black/[0.06] bg-white p-7 text-[#1d1d1f] shadow-[0_16px_64px_-24px_rgba(29,29,31,0.18)] sm:p-10">
      <Link href="/" className="text-sm font-semibold tracking-tight text-[#0071e3] transition-colors hover:text-[#005bb5]">
        GraduateStudio
      </Link>
      <h1 className="mt-6 text-3xl font-semibold tracking-tight">欢迎回来</h1>
      <p className="mt-3 text-sm leading-6 text-[#6e6e73]">
        登录账号，继续你的毕业设计。
      </p>

      <form action={formAction} className="mt-8 space-y-5" aria-busy={pending}>
        <div>
          <label htmlFor="email" className="block text-sm font-medium">
            邮箱
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            className="mt-2 w-full rounded-xl border border-[#d2d2d7] bg-[#f5f5f7] px-4 py-3 text-sm outline-none transition focus:border-[#0071e3] focus:bg-white focus:ring-4 focus:ring-[#0071e3]/10"
            placeholder="请输入邮箱地址"
          />
        </div>
        <div>
          <label htmlFor="password" className="block text-sm font-medium">
            密码
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className="mt-2 w-full rounded-xl border border-[#d2d2d7] bg-[#f5f5f7] px-4 py-3 text-sm outline-none transition focus:border-[#0071e3] focus:bg-white focus:ring-4 focus:ring-[#0071e3]/10"
            placeholder="请输入密码"
          />
        </div>

        {state.error ? (
          <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">
            {state.error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-xl bg-[#0071e3] px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0077ed] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#0071e3] disabled:cursor-wait disabled:opacity-60"
        >
          {pending ? "登录中…" : "登录"}
        </button>
      </form>

      <p className="mt-7 text-center text-sm text-[#6e6e73]">
        还没有账号？
        <Link href="/register" className="ml-1 font-medium text-[#0071e3] underline-offset-4 hover:underline">
          创建账号
        </Link>
      </p>
    </div>
  );
}
