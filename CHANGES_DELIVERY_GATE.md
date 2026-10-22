# 本次改动：交付闸门 + 骨架先行 + 纵切过闸（2026-10-22）

设计说明与使用步骤见 `docs/DELIVERY_GATE.md`。

## 新增

| 文件 | 作用 |
|---|---|
| `src/server/agents/delivery-gate.ts` | 交付闸门：缺失即 blocked；fast（干净副本从零构建+测试，Node/Maven/Python）与 full（compose 启动、健康检查、HTTP 冒烟、重启后持久化复查、Playwright 页面+截图）；失败项标注 code/environment |
| `src/server/agents/delivery-contract.ts` | `delivery/contract.json` 与 smoke 规格 schema |
| `src/server/agents/stack-profiles.ts` | 技术栈识别与档案（模板、worker 镜像） |
| `src/server/agents/codex-context.ts` | 技术栈/架构/API/数据库设计写入 `.gs-codex/context.md`；空工程套模板；生成 AGENTS.md |
| `resources/delivery-gate/smoke-runner.mjs`、`page-runner.mjs` | 平台自有的冒烟/页面执行器（只读挂载进探针容器） |
| `resources/templates/vue-spring-mysql/` | 骨架模板：compose、交付契约、AGENTS.md、gs-verify.sh、Spring Boot 3（鉴权/健康检查/Flyway/演示账号/公告示例纵切/6 个 MockMvc 测试）、Vue 3（登录/首页/公告页/2 个 vitest 测试） |
| `docker/codex-worker-java/` | 带 JDK17+Maven 的 Codex worker（模块内可编译后端，仍断网，复用闸门缓存） |
| `scripts/replay-gate.ts` | 用新闸门重放任意 stage（例如 10-17 的旧任务） |
| `scripts/inject-faults.md` | 7 项故障注入清单，用来验证闸门本身可信 |
| `docs/DELIVERY_GATE.md` | 设计、流程、首次使用、效果指标 |
| `tests/unit/delivery-gate.test.ts`、`stack-profiles.test.ts` | 新单元测试（假 docker，不需要真实容器） |

## 修改

| 文件 | 改动 |
|---|---|
| `codex-task.ts` | full：上下文落盘 → 套模板 → 骨架闸门 → 规划 v2（不合格带错误重试一次）→ 每模块生成后过闸+模块内修复，**只有过闸才 done**；`journal.generated` 支持从闸门继续；依赖清单变化后重新准备；规划/修复可用独立模型；提示词去掉“受阻就报告受阻”，Python 契约按需注入。local：同样走闸门与有界修复（blocked 且为代码原因也会修复） |
| `codex-plan.ts` | 计划 v2：每模块必须有可执行 smoke（HTTP + 页面，写入后回读或显式 readOnly），拒绝 v1 散文计划 |
| `codex-container.ts` | 按栈选择 worker 镜像（缺失时回退并提示）、挂载模板与缓存卷、按调用切换模型 |
| `codex-acceptance.ts` | 识别到非 Node 工程时记为 blocked，不再“从报告中消失” |
| `codex-post-apply.ts` | 应用后验证统一走交付闸门（Java 后端纳入验证，冻结计划的冒烟一并执行） |
| `adapters/codex.ts` | Windows 编码提示只在原生 Windows 宿主注入 |
| `codex-assets.ts`、`codex-workspace.ts`、`codex-resume-inventory.ts` | `target/`、`.gradle/`、`.venv/` 视为构建产物 |
| `context.ts` | 抽出 `buildArchitectureText` 供两套引擎共用 |
| `.env.example` | 新增 `GS_GATE_*`、`GS_CODEX_MODEL_PLAN/REPAIR`、Java worker 镜像等配置说明 |
| `eslint.config.mjs`、`.prettierignore` | 忽略模板与闸门执行器目录 |
| 测试 | `codex-plan.test.ts` 重写；`codex-acceptance.test.ts` 增加 10-17 回归用例；`codex-post-apply.test.ts`、`codex-task-orchestration.test.ts` 按新语义调整 |

## 验证情况（打包环境：无 Docker / Maven / 网络 / node_modules）

- ✅ 改动的 TS 源文件通过 `tsc --strict` 类型检查（Prisma 等依赖以 any 桩代替）。
- ✅ `delivery-gate`、`codex-plan`、`stack-profiles` 三个新测试文件 25/25 通过（离线 vitest 替身运行）。
- ✅ `smoke-runner.mjs` 对模拟后端实测：5 条 HTTP 冒烟 + 重启复查全部按预期产出，检查 ID 与闸门预期清单一致。
- ✅ `page-runner.mjs` 用真实 Chromium 对模拟前端实测：注入登录态、文本断言、3 张截图。
- ✅ 模板交付契约经平台代码校验：角色齐全、包含写入后回读、栈识别为 vue-spring-mysql。
- ⚠️ 未能执行：真实 `docker compose` 闸门、骨架模板的 Maven/Vite 构建、`pnpm test` 全量（尤其 `codex-task-orchestration.test.ts`、`codex-post-apply.test.ts` 依赖 vi.mock，需在本机跑）。
- ⚠️ 新文件未经 prettier 格式化，请执行一次 `pnpm format`。
