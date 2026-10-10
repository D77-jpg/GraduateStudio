# GraduateStudio

> AI 驱动的计算机毕业设计自动开发平台 —— 从一个想法,到一个完整的毕业设计。

核心流程:**选题 → 需求分析 → 架构设计 → UI 设计 → 数据库 → AI 开发 → 运行 → 测试 → 修复 → 部署 → 论文 → 答辩**

## 技术栈

| 层 | 选型 |
| --- | --- |
| 应用框架 | Next.js 16(App Router)+ TypeScript(strict) |
| UI | Tailwind CSS v4 |
| 数据库 | Prisma + SQLite(预留 PostgreSQL 迁移) |
| 认证 | Auth.js(NextAuth v5)+ 凭证登录(JWT 会话) |
| AI | Vercel AI SDK + 多 Provider 注册表(OpenAI / Anthropic / DeepSeek / GLM / OpenRouter) |
| 实时 | SSE(Server-Sent Events) |
| 状态 | Zustand + TanStack Query |
| 测试 | Vitest |
| 工程化 | pnpm + ESLint 9 + Prettier |

## 目录结构

```text
prisma/              数据库 schema / 迁移 / seed
docs/                产品规划与分阶段开发文档
src/
├── app/             路由(App Router)
│   ├── (auth)/      登录 / 注册
│   ├── (app)/       需登录的应用区(dashboard / settings)
│   └── api/         REST 路由(auth / health)
├── server/          仅服务端代码
│   ├── db.ts        Prisma 单例
│   ├── auth.ts      Auth.js 配置
│   ├── ai/          AI Provider 注册表
│   ├── realtime/    SSE 工具
│   └── workspace/   用户项目工作区(路径沙箱)
├── components/      UI 组件
├── hooks/  stores/  客户端状态与工具
tests/               Vitest 单元测试
```

## 快速开始

```bash
pnpm install
cp .env.example .env        # 按需填入 AI API Key(不填也能启动,仅 AI 功能不可用)
pnpm db:migrate             # 初始化数据库(首次会创建 dev.db)
pnpm db:seed                # 创建演示账号 demo@graduatestudio.dev / demo1234
pnpm dev                    # http://localhost:4311(固定 4311 端口,避免与本项目外服务冲突)
```

## 常用脚本

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 开发服务器 |
| `pnpm build` / `pnpm start` | 生产构建 / 启动 |
| `pnpm lint` | ESLint 检查 |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm test` | Vitest 单元测试 |
| `pnpm format` | Prettier 格式化 |
| `pnpm db:migrate` / `pnpm db:studio` | 数据库迁移 / 可视化管理 |

## 开发阶段(见 docs/GraduateStudio_ZCode_分阶段开发提示词.md)

```text
Phase 0  基础工程(当前)
Phase 1  产品壳层 + Dashboard
Phase 2  项目创建 + AI 选题 / 需求分析
Phase 3  AI 架构师 + 数据库设计
Phase 4  AI Coding Workspace
Phase 5  Agent 自动开发闭环
Phase 6  Preview / Terminal / Runtime
Phase 7  Testing + Debug
★ Phase 0~7 = V1.0 MVP
Phase 8+ Git / 论文 / 答辩 / 部署 / 打磨
```
