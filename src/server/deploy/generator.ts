import { z } from "zod";
import { generateObjectCompat } from "@/server/ai/compat";
import { AiNotConfiguredError } from "@/server/ai/provider";
import path from "node:path";
import fs from "node:fs";
import { db } from "@/server/db";
import { buildDocumentContext, joinContext } from "@/server/documents/context";
import { listProjectFilePaths, readFileOrNull } from "@/server/workspace/search";
import { resolveProjectDir, safeJoin } from "@/server/workspace/paths";
import { DEPLOY_API_PORT, DEPLOY_WEB_PORT } from "./manager";
import { logActivity } from "@/server/activity";

/**
 * Phase 11:AI 生成部署资产(依据真实项目)。
 * Docker 全套:两个 Dockerfile(前端 nginx 托管 / 后端 Node)+ nginx 反代 + compose(MySQL)+ env 模板 + 部署脚本 + 部署文档;
 * 部署文档同时覆盖 VPS 流程与 Vercel/Railway/Render 的适配要点(只做指引,不做云平台真实集成)。
 */

export class DeployAssetError extends Error {
  code: string;
  constructor(message: string, code = "deploy_asset_error") {
    super(message);
    this.name = "DeployAssetError";
    this.code = code;
  }
}

const assetsSchema = z.object({
  dockerfileWeb: z
    .string()
    .min(80)
    .describe("前端 Dockerfile(多阶段:构建 Vue/Vite → nginx 托管 dist)"),
  nginxConf: z
    .string()
    .min(60)
    .describe("nginx 配置:托管前端静态文件,并把 /api 反代到 api 容器(docker 网络主机名 api)"),
  dockerfileApi: z
    .string()
    .min(80)
    .describe("后端 Dockerfile(Node,生产依赖安装,暴露容器内端口 3000)"),
  dockerCompose: z
    .string()
    .min(300)
    .describe("docker-compose.yml:web/api/db(MySQL) 三服务,遵守约定的镜像名与端口映射"),
  envTemplate: z
    .string()
    .min(50)
    .describe(".env.example:数据库连接、JWT 密钥等(与项目源码里的环境变量读取一致)"),
  deployScript: z.string().min(80).describe("deploy.sh:VPS 一键部署脚本(构建/启动/健康检查/日志)"),
  deployReadme: z
    .string()
    .min(500)
    .describe("部署文档(Markdown):本地 Docker 流程、VPS 流程、Vercel/Railway/Render 适配要点"),
  schemaSql: z
    .string()
    .min(200)
    .describe(
      "MySQL 初始化 SQL:依据数据库设计的真实表/字段/关系生成 CREATE TABLE(先 CREATE DATABASE IF NOT EXISTS 并 USE)",
    ),
});

export type DeployAssets = z.infer<typeof assetsSchema>;

const IMAGE_BASE = (projectId: string) => `gs-${projectId.slice(0, 8)}`;

/** 收集部署相关上下文:项目/架构/数据库 + 包清单与关键配置文件。 */
async function buildDeployContext(projectId: string, userId: string): Promise<string> {
  const { texts } = await buildDocumentContext(projectId, userId, [
    "project",
    "architecture",
    "database",
  ]);
  const extra: string[] = [];
  for (const p of [
    "client/package.json",
    "backend/package.json",
    "client/vite.config.js",
    "backend/src/app.js",
    "server/pom.xml",
  ]) {
    const content = readFileOrNull(projectId, userId, p);
    if (content) extra.push(`--- ${p} ---\n${content.slice(0, 2_500)}`);
  }
  const files = listProjectFilePaths(projectId, userId).slice(0, 60);
  return [
    joinContext(texts, ["project", "architecture", "database"]),
    "",
    "## 关键配置文件",
    extra.join("\n\n") || "(无)",
    "",
    "## 文件树",
    ...files.map((f) => `- ${f}`),
  ].join("\n");
}

/** AI 生成部署资产并写盘;返回文件清单。 */
export async function generateDeployAssets(input: {
  projectId: string;
  userId: string;
}): Promise<{ files: Array<{ path: string; bytes: number }> }> {
  const project = await db.project.findFirst({
    where: { id: input.projectId, userId: input.userId },
    select: { name: true },
  });
  if (!project) throw new DeployAssetError("项目不存在或无权访问", "not_found");

  const context = await buildDeployContext(input.projectId, input.userId);
  const imageBase = IMAGE_BASE(input.projectId);

  let assets: DeployAssets;
  try {
    assets = await generateObjectCompat({
      system:
        "你是 DevOps 工程师。依据真实项目数据生成一套可运行的 Docker 部署资产,必须遵守以下硬性约定,否则部署无法工作:\n" +
        `1. 镜像名:web 服务 image 必须是 ${imageBase}-web,api 服务必须是 ${imageBase}-api(不带 tag);\n` +
        `2. 端口映射:web 用 \${DEPLOY_WEB_PORT:-${DEPLOY_WEB_PORT}}:80,api 用 \${DEPLOY_API_PORT:-${DEPLOY_API_PORT}}:3000;\n` +
        `3. docker-compose.yml 顶层不写 version 字段;web/api 的 build context 分别指向 ./client 与 ./backend,dockerfile 指向 ../deploy/Dockerfile.web 与 ../deploy/Dockerfile.api;\n` +
        "4. MySQL 服务名 db,带 healthcheck,api 通过 docker 网络主机名 db 访问,数据卷持久化;api depends_on db;\n" +
        "5. 前端是已构建产物由 nginx 托管,/api 反代到 api:3000;后端容器内监听 3000(如源码端口不同,用环境变量 APP_PORT=3000 约定并在 Dockerfile 里设置);\n" +
        "6. 环境变量模板要与源码里实际读取的变量名一致(从提供的配置文件判断);数据库连接用环境变量 DB_HOST=db 等。\n" +
        "只输出符合 JSON Schema 的内容,每个字段是文件的完整内容。",
      prompt: `为以下项目生成 Docker 部署资产。\n\n${context.slice(0, 16_000)}\n\n## 额外要求\n- deploy.sh 支持 build/up/healthcheck/logs 子命令,可 scp 到 VPS 使用\n- deployReadme 覆盖:本地 Docker 部署步骤、VPS 部署步骤(scp + ssh + 运行 deploy.sh)、以及 Vercel(前端)/Railway(全栈)/Render(全栈)三个平台各一节的适配要点(环境变量、构建命令、数据库替代方案),仅作指引\n- 文档开头列出资产清单`,
      schema: assetsSchema,
      schemaName: "DeployAssets",
      maxOutputTokens: 24_000,
      signal: AbortSignal.timeout(480_000),
    });
  } catch (error) {
    if (error instanceof AiNotConfiguredError) throw error;
    throw new DeployAssetError(
      `AI 生成部署资产失败:${error instanceof Error ? error.message : String(error)}`,
      "ai_failed",
    );
  }

  // 后处理兜底:alpine + npm ci 场景必须补 rollup 平台二进制(AI 可能遗漏)
  let dockerfileWeb = assets.dockerfileWeb;
  if (
    /alpine/i.test(dockerfileWeb) &&
    /npm ci/.test(dockerfileWeb) &&
    !/rollup-linux-x64-musl/.test(dockerfileWeb)
  ) {
    dockerfileWeb = dockerfileWeb.replace(
      /(RUN npm ci[^\n]*)/,
      "$1 && npm install --no-save @rollup/rollup-linux-x64-musl || true",
    );
  }
  const files: Array<{ path: string; content: string }> = [
    { path: "deploy/Dockerfile.web", content: dockerfileWeb },
    { path: "deploy/nginx.conf", content: assets.nginxConf },
    { path: "deploy/Dockerfile.api", content: assets.dockerfileApi },
    { path: "docker-compose.yml", content: assets.dockerCompose },
    { path: "deploy/.env.example", content: assets.envTemplate },
    { path: "deploy/deploy.sh", content: assets.deployScript },
    { path: "deploy/DEPLOY-README.md", content: assets.deployReadme },
    { path: "deploy/schema.sql", content: assets.schemaSql },
  ];
  const written: Array<{ path: string; bytes: number }> = [];
  for (const f of files) {
    const abs = safeJoin(resolveProjectDir(input.projectId), f.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content, "utf8");
    written.push({ path: f.path, bytes: Buffer.byteLength(f.content, "utf8") });
  }
  await logActivity(
    input.projectId,
    "ai",
    "AI 生成部署资产(Docker 全套 + 部署文档)",
    written.map((f) => `${f.path}(${f.bytes}B)`).join(", "),
  );
  return { files: written };
}
