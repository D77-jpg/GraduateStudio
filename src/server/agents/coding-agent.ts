import { streamText } from "ai";
import {
  generateObjectCompat,
  AiRequestTimeoutError,
  type AiRequestEventCallback,
} from "@/server/ai/compat";
import { getChatModel, AiNotConfiguredError } from "@/server/ai/provider";
import { planOutputSchema, implementOutputSchema } from "@/lib/develop";
import type { z } from "zod";
import { buildCodingContext, renderContextForPrompt } from "./context";
import { selectRelevantGenerationPaths } from "@/lib/generation-efficiency";
import { assertGenerationPlan, assertImplementationCoverage } from "@/lib/generation-quality";
import { configuredAgentEngine } from "./adapters";
import { parseCodexImplementationResult } from "./adapters/codex-result";

function generationSignal(signal?: AbortSignal): AbortSignal {
  return signal ?? new AbortController().signal;
}

/**
 * Coding Agent:计划(Plan)→ 实现(Implement)→ 聊天(Chat)。
 * 只生成"待确认的变更集",绝不直接写盘;自动执行闭环属于 Phase 5 的 Agent 编排器。
 */

export class CodingAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodingAgentError";
  }
}

function mapError(error: unknown, signal?: AbortSignal, parent?: AbortSignal): never {
  if (parent?.aborted) throw parent.reason;
  if (signal?.aborted) throw signal.reason;
  if (
    error instanceof Error &&
    ["AiRequestTimeoutError", "AiOutputFormatError"].includes(error.name)
  )
    throw error;
  if (error instanceof AiNotConfiguredError) throw error;
  if (error instanceof Error && error.name === "AbortError") throw error;
  if (error instanceof Error && error.name === "TimeoutError") {
    throw new AiRequestTimeoutError();
  }
  throw new CodingAgentError(`AI 调用失败:${error instanceof Error ? error.message : "未知错误"}`);
}

const UI_ONLY_MESSAGE_RE = /(界面|页面|UI|UX|视觉|样式|美化|前端|交互)/i;

const SYSTEM_BASE = `你是 GraduateStudio 的编码 Agent,在一个学生毕业设计项目的工作区里协助开发。
规则:
1. 所有路径都是项目内的相对路径(正斜杠),禁止出现 ..、绝对路径、node_modules、.git。
2. 输出严格遵循给定 JSON Schema,只输出一个完整 JSON 对象,不附带解释或 Markdown 围栏。content 必须是合法 JSON 字符串：换行、双引号与反斜杠必须正确转义；代码中的模板字符串、正则和 Markdown 围栏也是字符串内容，不得破坏外层 JSON。输出前检查所有文件条目与外层对象均完整闭合。文本用简体中文,代码要完整可运行(不写占位注释代替实现)。
3. 修改文件时给出修改后的【完整】文件内容,不要输出 diff 片段或省略号。
4. 尊重现有技术栈与代码风格,不擅自引入与项目无关的重型依赖。
5. 交付真实业务闭环,禁止将生产功能实现成 mock-only、静态假数据或仅展示页面;测试夹具可用 mock,生产路径不得依赖它。
6. 前端调用必须与已有/计划后端 API 的路径、HTTP 方法、鉴权、请求/响应字段一致;覆盖加载、空态与失败处理,不得虚构接口。
7. 使用项目指定的真实数据库、现有 ORM/持久层与 schema,必要时计划迁移;禁止以内存数组、Map 或 localStorage 替代服务端持久化,保留权限校验与输入验证。
8. 每个模块职责有界,按 UI、API、业务服务、数据访问/模型与测试合理拆分;不要把整个系统塞入单个巨大文件。必须实现正常路径与关键错误路径,不得用 TODO、省略号或未实现异常代替业务实现。`;

export async function generatePlan(input: {
  projectId: string;
  userId: string;
  message: string;
  selectedFilePaths?: string[];
  signal?: AbortSignal;
  /** Full-project modules own only their responsibilities, not the entire delivery. */
  moduleScoped?: boolean;
  onRequestEvent?: AiRequestEventCallback;
}): Promise<z.infer<typeof planOutputSchema>> {
  const signal = generationSignal(input.signal);
  try {
    signal.throwIfAborted();
    const context = await buildCodingContext(
      input.projectId,
      input.userId,
      input.selectedFilePaths,
      {
        autoSelectPlanningFiles: true,
      },
    );
    signal.throwIfAborted();
    const uiOnly = UI_ONLY_MESSAGE_RE.test(input.message);
    const scopeRule = uiOnly
      ? "UI任务范围硬约束：只允许 client/ 下的前端页面、组件、布局、样式、路由、API调用封装和前端测试；禁止计划 deploy/、docs/、backend/、server/、数据库schema或后端业务文件。"
      : "按用户需求确定范围；不得无依据扩大到不相关层。";

    const parsed = await generateObjectCompat({
      system: SYSTEM_BASE,
      prompt: `${renderContextForPrompt(context)}

## 用户任务
${input.message}

${scopeRule}

请基于项目现状制定一个清晰的修改计划:每一步对应一个要新建/修改/删除的文件,说明原因。
要求:文件路径不重复;每个文件的职责单一;计划完整、可执行、可验收，不以固定文件数量限制任务范围。
${input.moduleScoped ? "仅按当前模块职责规划文件，不为未来模块提前生成业务实现或重复已有模块；明确本模块文件所有权与提供/消费的接口契约，仅安排本模块必要测试，交付配置/部署说明留给最终模块。" : uiOnly ? "UI任务只规划前端范围，不修改后端、部署、数据库或无关文档；已有前端接口先复用，不为视觉任务扩展业务后端。" : "按依赖顺序覆盖 schema/迁移、真实数据库持久化服务、API、前端接入、构建/启动配置与可运行的关键业务测试文件。"}已有文件先依据上下文分析,新接口明确请求/响应契约,不得只计划 mock 页面或忽略数据库;给出可执行的构建/测试验收方式。`,
      schema: planOutputSchema,
      schemaName: "CodingPlan",
      signal,
      onRequestEvent: input.onRequestEvent,
    });
    signal.throwIfAborted();
    assertGenerationPlan(parsed.steps);
    if (uiOnly) {
      const invalid = parsed.steps.filter((step) => !step.path.startsWith("client/"));
      if (invalid.length)
        throw new Error(`UI任务计划越界：${invalid.map((step) => step.path).join("、")}`);
    }
    return parsed;
  } catch (error) {
    mapError(error, signal, input.signal);
  }
}

export async function generateImplementation(input: {
  projectId: string;
  userId: string;
  message: string;
  plan: z.infer<typeof planOutputSchema>;
  selectedFilePaths?: string[];
  signal?: AbortSignal;
  maxOutputTokens?: number;
  onRequestEvent?: AiRequestEventCallback;
}): Promise<z.infer<typeof implementOutputSchema>> {
  const signal = generationSignal(input.signal);
  try {
    signal.throwIfAborted();
    assertGenerationPlan(input.plan.steps);
    const modifyPaths = input.plan.steps
      .filter((step) => step.action === "modify")
      .map((step) => step.path);
    const context = await buildCodingContext(
      input.projectId,
      input.userId,
      [
        ...selectRelevantGenerationPaths(
          input.selectedFilePaths ?? [],
          input.plan.steps.filter((step) => step.action !== "delete").map((step) => step.path),
          24,
        ),
        ...input.plan.steps.filter((step) => step.action !== "delete").map((step) => step.path),
      ].filter((path, index, all) => all.indexOf(path) === index),
      { requiredFullFilePaths: modifyPaths },
    );
    signal.throwIfAborted();

    const planText = input.plan.steps
      .map(
        (step, index) =>
          `${index + 1}. [${step.action}] ${step.path}${step.reason ? ` — ${step.reason}` : ""}`,
      )
      .join("\n");

    const engine = configuredAgentEngine();
    if (engine) {
      const result = await engine.run(
        {
          projectId: input.projectId,
          workspace: (await import("@/server/workspace/paths")).resolveProjectDir(input.projectId),
          prompt: `${SYSTEM_BASE}\n${renderContextForPrompt(context)}\n\n用户任务：${input.message}\n\n已确认计划：${planText}\n不得实际修改文件；仅输出提议。输出必须是严格 JSON，形如 {"notes":"实现说明","changes":[{"action":"modify","path":"项目相对路径","content":"完整文件内容"}]}。changes 必须覆盖且仅覆盖计划的所有文件，动作保持一致；delete 的 content 为空字符串。`,
          mode: "read-only",
          allowedPaths: input.plan.steps.map((step) => step.path),
          forbiddenPaths: [".env", "node_modules", ".git"],
          signal,
        },
        input.onRequestEvent
          ? () =>
              input.onRequestEvent?.({
                type: "progress",
                attempt: 1,
                provider: "openai",
                model: "codex-cli",
                durationMs: 0,
                textChars: 0,
                reasoningChars: 0,
              })
          : undefined,
      );
      const codexResult = parseCodexImplementationResult(result);
      assertImplementationCoverage(input.plan.steps, codexResult.changes);
      return codexResult;
    }

    const parsed = await generateObjectCompat({
      system: SYSTEM_BASE,
      prompt: `${renderContextForPrompt(context)}

## 用户任务
${input.message}

## 已确认的修改计划
${planText}

${input.plan.risks ? `## 计划风险提示\n${input.plan.risks}\n` : ""}
请严格按照计划执行,输出每个文件的完整内容:
- create:新文件的完整内容
- modify:「用户当前打开的文件」一节中已有这些文件的最新内容,基于它们修改后输出完整内容
- delete:content 传空字符串
注意:本次计划可能是大任务的一个依赖有序批次,仅实现本批次;不要遗漏任何文件、改变动作、重复路径或添加计划之外的文件。create/modify 不得为空或仅包含占位内容;所有修改文件必须保留完整现有功能。前端/API/数据库契约必须对齐,无法实现时明确报错,禁止悄悄降级为 mock 或内存存储。`,
      schema: implementOutputSchema,
      schemaName: "CodeChanges",
      signal,
      onRequestEvent: input.onRequestEvent,
    });
    signal.throwIfAborted();
    assertImplementationCoverage(input.plan.steps, parsed.changes);
    return parsed;
  } catch (error) {
    mapError(error, signal, input.signal);
  }
}

/** AI 聊天(流式):返回 streamText 结果,路由层遍历 fullStream 转 SSE(reasoning + 文本)。 */
export async function streamChat(input: {
  projectId: string;
  userId: string;
  message: string;
  selectedFilePaths?: string[];
  signal?: AbortSignal;
}) {
  const signal = generationSignal(input.signal);
  signal.throwIfAborted();
  const context = await buildCodingContext(
    input.projectId,
    input.userId,
    input.selectedFilePaths ?? [],
  );

  return streamText({
    model: getChatModel(),
    system: SYSTEM_BASE,
    prompt: `${renderContextForPrompt(context)}

## 用户消息
${input.message}

请作为编码助手回答:可以讨论方案、解释代码、给建议;真正的代码修改请让用户走「生成修改计划」流程。回答使用简体中文,简洁专业。`,
    maxRetries: 0,
    abortSignal: signal,
  });
}

export { renderContextForPrompt };
