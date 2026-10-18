# GraduateStudio Codex 重构：Stage 0

## 当前结论

Codex CLI 已在本机安装，可用命令为 `codex exec --json`，版本由本机 CLI 查询确认。一次无修改临时探测观察到 JSONL 生命周期：`thread.started`、`turn.started`、`error`、`turn.failed`。由于本机 Codex 登录 refresh token 已撤销，探测未进入代码工具事件，也没有声称 Codex 已完成真实项目执行。

## 已实现的安全边界

- `src/server/agents/engine.ts`：平台无关 AgentEngine、任务、结果和生命周期事件类型。
- `src/server/agents/adapters/codex.ts`：Codex JSONL 子进程适配器，固定 `exec --json --ephemeral --skip-git-repo-check` 参数，固定 sandbox/approval/cwd，输出行大小限制、超时、取消、Windows 进程树清理和事件映射。
- Codex 接入 `coding-agent.generateImplementation` 时默认使用 `read-only` sandbox，仅产出并校验 JSON 提议；现阶段不会允许 Codex 直接写项目文件。
- `src/server/agents/adapters/index.ts`：Codex 引擎工厂，只有 `GRADUATESTUDIO_AGENT_ENGINE=codex` 才选择 Codex；默认返回 Legacy fallback。
- `tests/unit/codex-engine.test.ts`：生命周期、JSONL 错误、结果聚合测试，2/2通过；全局 TypeScript 通过。

## 尚未宣称完成的部分

目前适配器是独立 PoC，尚未替换普通 Runner、未修改 AgentTask/AgentStep Prisma schema、未接管 ChangeSet、验收、修复、Git 或生产写盘策略。默认仍使用现有 Legacy Runner。Codex 登录失效，所以尚未完成真实 Codex 模型端到端运行。

## 下一阶段

优先把 Codex 适配器接到 `coding-agent.generateImplementation` 的单一、可回滚操作，并让 Codex只生成经过 `implementOutputSchema` 校验的提议；文件实际写入仍由现有 pending ChangeSet → accept 流程完成。之后再考虑 AgentRun/AgentEvent 持久化迁移，不直接重写当前任务检查点。

## 用户需要做的事情

若要进行真实 Codex PoC，请先在本机执行 `codex login` 修复已撤销的登录状态，并设置 `GRADUATESTUDIO_AGENT_ENGINE=codex` 前只在临时项目运行。不要在生产项目上开启该开关；当前默认 Legacy，安全不变。
