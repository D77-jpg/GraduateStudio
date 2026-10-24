# 交付闸门（Delivery Gate）与“骨架先行 + 纵切过闸”改造

## 1. 要解决的问题

2026-10-17 的 full 任务：217 个 Java 文件从未编译，验收报告却是 `passed`。根因有两层：

1. **缺失即通过**：`codex-acceptance.ts` 只认 `package.json`，`server/pom.xml` 不产生任何检查；
   `result()` 的规则是“出现的检查里没有失败就 passed”。
2. **agent 没有反馈回路**：worker 镜像只有 Node/Python、断网，提示词还要求“缺依赖就说明受阻”，
   模型只能盲写后端，并诚实地在报告里写“未执行”。

## 2. 新的完成定义

> `passed` = 本次**应当出现**的每一项检查都实际执行并通过。

| 层 | 检查 | 实现 |
|---|---|---|
| 结构 | 识别到的每个工程都有对应检查器；不支持的栈（Gradle/Go/…）→ blocked | `stack-profiles.ts` |
| fast | 干净副本中从零安装依赖 → 构建 → 测试（必须有“N passed / Tests run: N”证据） | `delivery-gate.ts` nodeChecks / mavenCheck / pythonCheck |
| full | `docker compose up --build --wait` → 健康检查 → HTTP 冒烟（含写入后回读）→ 重启后端复查持久化 → Playwright 页面检查 + 截图 | `runtimeChecks` + `resources/delivery-gate/*.mjs` |

- 每个未通过项带 `cause`：`code` 触发修复；`environment`（Docker/网络/不支持的栈）直接暂停，不花模型钱。
- 闸门总在 stage 的**临时副本**上运行，构建产物不会进入变更集；宿主端口被 override 去掉，与预览实例互不冲突。
- 截图保存在任务状态目录 `gate-artifacts/<label>/`，即论文可用的系统运行截图。

## 3. 交付契约 `delivery/contract.json`

生成项目根目录必须有 `compose.yaml` 与该文件：后端/前端服务名与端口、健康检查路径、登录接口与令牌字段路径、
前端令牌存储键、演示账号、骨架级冒烟。闸门据此做与技术栈无关的运行时验收。格式见 `delivery-contract.ts`。

## 4. 编排流程（`codex-task.ts` full 模式）

1. 加载项目上下文（技术栈 + 架构 + API + 数据库设计）写入 `.gs-codex/context.md`（旧版从未传给 Codex）。
2. 空工程 → 复制经过验证的骨架模板 `resources/templates/<profile>`（零模型成本）。
3. **骨架闸门**：系统在写任何业务代码前必须能启动、登录、通过健康检查与骨架冒烟。
4. 规划 v2：每个模块是功能纵切，必须带可执行 smoke；不合格时带着校验错误重试一次。计划冻结在 stage 之外的 `journal.json`。
5. 每个模块：生成 → 闸门（回归运行已完成模块的冒烟）→ 失败则模块内修复（最多 `GS_GATE_MAX_REPAIRS` 轮）→
   **只有通过才进入 `done`**；仍失败则暂停，`journal.generated` 记录已生成未通过的模块，继续时从闸门开始。
6. 最后一个模块的 full 闸门即最终交付结果；生成变更集供审阅，摘要写明闸门结果与截图数量。

局部修改（local）同样走闸门（有契约时 full，否则 fast），带有界修复。应用后验证（post-apply）也统一走闸门。

## 5. 首次使用

```bash
# 1) 构建 worker 镜像（Java 工具链镜像可选，但强烈建议：让模型在模块内就能编译后端）
docker build -t gs-codex-worker:0.150.1 docker/codex-worker
docker build -t gs-codex-worker-java:0.150.1 docker/codex-worker-java

# 2) 先单独验证骨架模板在本机可运行（同时预热 Maven/npm 缓存）
cp -r resources/templates/vue-spring-mysql /tmp/skeleton && cd /tmp/skeleton
docker compose up -d --build --wait && curl -s localhost:8080/api/health && docker compose down -v

# 3) 用闸门跑一遍模板（应当 passed，并在 .gate-replay/ 下产出 3 张截图）
pnpm tsx scripts/replay-gate.ts /tmp/skeleton --tier full

# 4) 重放 10-17 的旧 stage（应当 failed/blocked，并给出真实编译错误）
pnpm tsx scripts/replay-gate.ts .agent-state/<projectId>/codex-tasks/<taskId>/stage

# 5) 故障注入：scripts/inject-faults.md 中 7 项必须全部被拦下
```

## 6. 怎么判断改造有效（建议每次完整生成后记录）

| 指标 | 来源 | 目标 |
|---|---|---|
| 假 passed 次数 | 人工 `docker compose up` 抽查 vs 闸门结论 | 0 |
| 模块首次过闸率 | `journal.gates` + 修复步骤数 | > 60% |
| 平均每模块修复轮数 | 步骤记录 “修复交付闸门失败” | 逐步下降 |
| 模块内是否运行了构建 | 活动日志中 `gs-verify` / `mvn` 工具调用 | 每模块 ≥ 1 |
| 全程 token / 费用 | 模型网关计费 | 与改造前同题目对比 |

## 7. 已知限制

- 平台只为 Node / Maven / Python 提供检查器；其他栈会被明确标记为 blocked（这是刻意的）。
- 闸门构建需要访问 Maven Central / npm / PyPI（或配置镜像）；Codex worker 本身仍断网，只复用缓存。
- `!reset` 端口覆盖需要 Docker Compose ≥ 2.24.4；旧版本可设 `GS_GATE_KEEP_PORTS=1`（此时注意端口冲突）。
- 只提供了 `vue-spring-mysql` 一个骨架模板；`vue-fastapi`、`node-fullstack` 档案会让模型按约定先搭骨架再过闸。
