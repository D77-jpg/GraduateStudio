"use server";

import { AuthError, CredentialsSignin } from "next-auth";
import { signIn } from "@/server/auth";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/server/db";

export interface AuthFormState {
  error?: string;
}

const loginSchema = z.object({
  email: z.email("请输入有效的邮箱地址"),
  password: z.string().min(1, "请输入密码"),
});

const registerSchema = loginSchema.extend({
  name: z.string().trim().min(1, "请输入昵称").max(32, "昵称过长"),
  password: z.string().min(8, "密码至少 8 位").max(64, "密码过长"),
});

export async function loginAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = loginSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "请输入正确的邮箱和密码" };
  }

  try {
    await signIn("credentials", { ...parsed.data, redirectTo: "/dashboard" });
  } catch (error) {
    if (error instanceof AuthError) {
      if (error instanceof CredentialsSignin) return { error: "邮箱或密码错误" };
      return { error: "登录失败,请稍后重试" };
    }
    throw error;
  }
  return {};
}

export async function registerAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = registerSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "请检查输入内容" };
  }

  const { name, email, password } = parsed.data;
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return { error: "该邮箱已被注册" };

  const passwordHash = await bcrypt.hash(password, 10);
  await db.user.create({ data: { name, email, passwordHash } });

  try {
    await signIn("credentials", { email, password, redirectTo: "/dashboard" });
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: "注册成功,但自动登录失败,请手动登录" };
    }
    throw error;
  }
  return {};
}
