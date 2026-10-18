# AI 自主开发升级：工程调查与修复闭环（第一阶段）

## 目标及已实施能力

将“生成计划→分批生成→验收失败停止”的主要修复入口升级为：

真实验收 → 模型提出根因假设 → 工具读取工程/搜索调用方 → 可选单测试复现 → 引用工具观察的调查结论 → 最小修复计划 → 变更集应用 → 定向验收 → 全量验收。

当前接入完整项目任务 full-project.ts 与普通自主任务 runner.ts。完整项目旧检查点新增可选 investigation 字段，保持旧格式兼容；已持久化未完成计划仍保留，避免恢复时擅自丢弃已应用部分。

## 工具

src/server/agents/investigation-tools.ts 提供：
- list_files：有限目录列举。
- read_file：按行号读取，最多200行/16K输出，支持后续offset。
- search_text：字面量搜索，非任意正则/命令。
- node_test：仅 backend/server 下已有 tests/**/*.test.js|cjs|mjs，固定 node --test 单文件，不传入模型命令字符串；最多约30秒并终止进程树。单测输出不能冒充全工程通过。

路径拒绝遍历、绝对路径、符号链接及其祖先；忽略node_modules/.git/产物与常见秘密文件。Node测试使用本地验收TEST_DB配置，不修改管理员账号、业务库配置或Docker服务。不提供任意shell、数据库管理或写入工具。

重要边界：测试执行的是项目代码，并非OS安全沙箱，项目测试自身可能有副作用。文件名称过滤也不是通用秘密发现机制，源码中硬编码秘密应另行清理。

## 决策循环

src/server/agents/investigation.ts 基于现有多Provider结构化输出兼容层，每次请求产生一个tool或conclude动作，实际执行后把结果返回模型。日志/代码均当作非可信证据，不作为指令。

- 修复结论必须引用存在的成功观察，且至少读取目标源码。
- 真实单测失败exitCode=1可作为复现证据，不转成通过。
- 无效证据、权限拒绝、重复请求、工具预算耗尽产生insufficient；不猜测写代码。
- environment结论只记录操作指引，不自动改数据库账号、关闭保护或跳过测试。
- 每次调查默认8轮、最多12轮，这是工具交互成本/无效循环保护，不是完成声明。复杂问题可能仍需下一次调查；未实现无限自主运行。
- 观察以diagnostic任务步骤保存，完整任务结论保存于检查点并注入后续计划。

## 写入与验收

调查本身无写入。修改仍走原generatePlan/generateImplementation与可追溯变更集。保留完整原文件、禁止跨越失败子工程的无关修复、禁止删测试/新增skip/减少可识别断言/替换build或test脚本。

这些保护仅检测明显绕过，不是形式化语义证明；模型写出的改动仍必须真实执行测试。定向通过后必须全量验收。相同失败无进展仍停止，避免无限生成。

## 与成熟开发Agent的差距

本阶段不是Codex/Claude Code/zcode/DSH全能力等价：
- 工具执行目前只支持单文件Node测试；前端/Maven仍依赖原全套验收，不支持任意终端工具。
- 创建项目仍采用依赖有序模块计划，不是完全自由的任务执行器。
- 初始规划尚未接入全工具调查，主要增强验收失败后的根因调查。
- 没有浏览器/E2E、外部文档工具、自动DB环境管理、容器沙箱、通用原生tool-call协议或语义补丁编辑。
- 普通任务没有完整任务同等的断点持久化游标，不能宣称所有任务均有成熟恢复能力。
- 旧修复计划有已应用前缀时不会自动全部重写。
- 未用用户付费模型自动运行真实任务，回归使用注入决策与临时真实Node测试；因此实际模型调查质量仍需在真实任务中观察。

## 关键文件

- src/server/agents/investigation-tools.ts
- src/server/agents/investigation.ts
- src/server/agents/full-project.ts
- src/server/agents/runner.ts
- src/lib/full-project.ts
- tests/unit/investigation-tools.test.ts
- tests/unit/investigation.test.ts
- tests/unit/full-project-orchestration.test.ts
- tests/unit/agent-investigation-runner.test.ts

## 回归验证

平台44个测试文件、633个测试通过。完成后再次针对工具、决策、普通任务和完整项目编排运行98个测试，全部通过。新增调查工具32例、调查决策7例、普通任务闭环8例，以及完整任务调查阻断回归。TypeScript、ESLint和生产构建验证单独执行；临时Node测试真实执行，但模型决策和任务数据库使用mock，不冒充生成项目验收成功。

生成的校园活动项目已有缺陷不会因为平台构建通过自动消失，也没有在本阶段直接覆盖其源码。应由升级后的调查/修复任务处理，再观察真实验收，不能承诺一次通过。
