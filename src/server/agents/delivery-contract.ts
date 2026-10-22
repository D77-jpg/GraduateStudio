import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * 交付契约：生成项目根目录的 delivery/contract.json。
 * 它告诉平台“这个系统怎么启动、怎么判断活着、怎么登录、用什么演示账号”，
 * 使交付闸门可以不理解具体技术栈也能做运行时验收（compose 启动 + HTTP 冒烟 + 浏览器页面）。
 */

const servicePort = z.number().int().min(1).max(65535);
const relativeUrl = z.string().regex(/^\/[^\s]*$/, "必须是以 / 开头的相对路径");

export const smokeSpecSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("http"),
      name: z.string().min(1).max(200).optional(),
      /** 以哪个演示账号角色登录后请求；省略表示匿名。 */
      as: z.string().min(1).max(60).optional(),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      path: relativeUrl,
      body: z.unknown().optional(),
      expectStatus: z.number().int().min(100).max(599),
      /** 点路径 → 期望值；值为 "*" 表示“存在且非空”。 */
      expectJson: z.record(z.string(), z.unknown()).optional(),
      /** 变量名 → 点路径，保存响应字段供后续步骤以 {{变量名}} 引用。 */
      saveAs: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,40}$/), z.string()).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("page"),
      name: z.string().min(1).max(200).optional(),
      as: z.string().min(1).max(60).optional(),
      route: relativeUrl,
      expectText: z.array(z.string().min(1).max(200)).min(1).max(10),
    })
    .strict(),
]);
export type SmokeSpec = z.infer<typeof smokeSpecSchema>;

export const deliveryContractSchema = z
  .object({
    version: z.literal(1),
    /** compose 网络名（不含项目前缀），默认 default。 */
    network: z.string().regex(/^[a-zA-Z0-9_.-]{1,60}$/).optional(),
    backend: z
      .object({ service: z.string().min(1).max(60), port: servicePort, health: relativeUrl })
      .strict(),
    frontend: z
      .object({
        service: z.string().min(1).max(60),
        port: servicePort,
        health: relativeUrl.optional(),
      })
      .strict()
      .optional(),
    auth: z
      .object({
        loginPath: relativeUrl,
        usernameField: z.string().min(1).default("username"),
        passwordField: z.string().min(1).default("password"),
        tokenJsonPath: z.string().min(1),
        header: z.string().min(1).default("Authorization"),
        scheme: z.string().default("Bearer"),
        frontendStorage: z
          .object({ type: z.enum(["localStorage", "sessionStorage"]), key: z.string().min(1) })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    accounts: z
      .array(
        z
          .object({
            role: z.string().min(1).max(60),
            username: z.string().min(1).max(120),
            password: z.string().min(1).max(200),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    /** 骨架级冒烟：与业务模块无关、系统起来就必须成立的检查（登录、首页）。 */
    smoke: z.array(smokeSpecSchema).max(50).default([]),
  })
  .strict();
export type DeliveryContract = z.infer<typeof deliveryContractSchema>;

export const CONTRACT_PATH = "delivery/contract.json";
export const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"];

export async function findComposeFile(root: string): Promise<string | null> {
  for (const name of COMPOSE_FILES) {
    try {
      const stat = await fs.lstat(path.join(root, name));
      if (stat.isFile() && !stat.isSymbolicLink()) return name;
    } catch {
      /* next */
    }
  }
  return null;
}

export type ContractLoad =
  | { status: "missing" }
  | { status: "invalid"; error: string }
  | { status: "ok"; contract: DeliveryContract };

export async function loadDeliveryContract(root: string): Promise<ContractLoad> {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, CONTRACT_PATH), "utf8");
  } catch {
    return { status: "missing" };
  }
  try {
    return { status: "ok", contract: deliveryContractSchema.parse(JSON.parse(text)) };
  } catch (error) {
    return { status: "invalid", error: String(error instanceof Error ? error.message : error) };
  }
}

/** 冒烟引用的角色必须在契约账号里存在，否则检查本身无法执行。 */
export function missingRoles(contract: DeliveryContract, smoke: SmokeSpec[]): string[] {
  const roles = new Set(contract.accounts.map((a) => a.role));
  return [...new Set(smoke.map((s) => s.as).filter((r): r is string => !!r && !roles.has(r)))];
}

/** 写操作之后必须有一个用保存变量回读的 GET，证明数据真的被持久化而不是前端假数据。 */
export function hasWriteWithReadback(smoke: SmokeSpec[]): boolean {
  const saved = new Set<string>();
  let wrote = false;
  for (const step of smoke) {
    if (step.kind !== "http") continue;
    if (step.method !== "GET") {
      wrote = true;
      for (const name of Object.keys(step.saveAs ?? {})) saved.add(name);
      continue;
    }
    if (wrote && [...step.path.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g)].some((m) => saved.has(m[1])))
      return true;
  }
  return false;
}
