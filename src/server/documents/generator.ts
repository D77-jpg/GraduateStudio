import { db } from "@/server/db";
import { generateText } from "ai";
import { getChatModel } from "@/server/ai/provider";
import {
  buildDocumentContext,
  joinContext,
  type DataSourceKind,
  type DependencySnapshot,
} from "./context";

/**
 * Phase 9:章节生成与 AI 编辑。
 * 每个章节声明自己的数据源,生成时只读这些真实项目数据;禁止编造功能/技术。
 * 长文本章节用 generateText(非 JSON);摘要英文版由中文摘要翻译而来。
 */

export class DocumentError extends Error {
  code: string;
  constructor(message: string, code = "doc_error") {
    super(message);
    this.name = "DocumentError";
    this.code = code;
  }
}

const GEN_TIMEOUT_MS = 480_000;
const MAX_SECTION_TOKENS = 16_000;

export interface SectionDef {
  key: string;
  title: string;
  kinds: DataSourceKind[];
  instruction: string;
  /** 目录/摘要英文等特殊章节 */
  special?: "toc" | "abstract-en";
}

/** 说明书章节结构(文档中心的说明书骨架) */
export const THESIS_SECTIONS: SectionDef[] = [
  {
    key: "abstract",
    title: "摘要(中文)",
    kinds: ["project", "requirements", "architecture", "code", "tests"],
    instruction:
      "撰写毕业论文中文摘要(500-700 字,单段落或两段):依次涵盖项目背景、研究内容、使用技术、系统功能、实现成果。只能使用提供数据中出现的技术与功能,禁止编造。末尾附 3-5 个关键词(以'关键词:'开头)。",
  },
  {
    key: "abstract-en",
    title: "Abstract(英文摘要)",
    kinds: [],
    instruction: "把中文摘要忠实翻译为学术英语摘要",
    special: "abstract-en",
  },
  {
    key: "toc",
    title: "目录",
    kinds: [],
    instruction: "目录由各章节标题自动生成",
    special: "toc",
  },
  {
    key: "ch1-introduction",
    title: "第一章 引言",
    kinds: ["project", "requirements"],
    instruction:
      "撰写'第一章 引言',使用 Markdown,含小节(1.1 项目背景与开发意义、1.2 国内外研究现状、1.3 主要研究内容、1.4 论文组织结构)。现状综述保持通用与客观,不得虚构具体文献数据;研究内容必须来自需求分析中的真实功能模块。全文 800-1200 字。",
  },
  {
    key: "ch2-technologies",
    title: "第二章 相关技术介绍",
    kinds: ["architecture", "code"],
    instruction:
      "撰写'第二章 相关技术介绍',Markdown 小节按架构技术栈逐项介绍(如 2.1 前端技术、2.2 后端技术、2.3 数据库、2.4 开发与构建工具)。只介绍技术栈列表里真实使用的技术,说明其在本项目中的用途;禁止添加未使用的技术。全文 800-1200 字。",
  },
  {
    key: "ch3-requirements",
    title: "第三章 需求分析",
    kinds: ["requirements", "database"],
    instruction:
      "撰写'第三章 需求分析',Markdown 含小节:3.1 可行性分析(简述)、3.2 用户角色分析、3.3 功能需求分析(按功能模块逐项描述,用列表)、3.4 非功能需求分析(性能/安全/可维护性等,来自非功能需求数据)、3.5 系统边界。所有功能必须与需求数据一致,不得虚构。全文 1000-1500 字。",
  },
  {
    key: "ch4-design",
    title: "第四章 系统设计",
    kinds: ["architecture", "requirements"],
    instruction:
      "撰写'第四章 系统设计',Markdown 含小节:4.1 系统总体架构(描述分层与前后端架构)、4.2 功能模块设计(按系统模块列表逐个说明职责)、4.3 核心业务流程设计(按业务流程数据描述步骤)、4.4 接口设计(从 API 规划中挑选代表性接口,用表格列出方法/路径/说明)。内容必须与架构数据一致。全文 1000-1500 字。",
  },
  {
    key: "ch5-database",
    title: "第五章 数据库设计",
    kinds: ["database"],
    instruction:
      "撰写'第五章 数据库设计',Markdown 含小节:5.1 数据库总体设计(引擎与设计原则)、5.2 数据表设计(每张表一个小标题,用 Markdown 表格列出字段名/类型/约束/说明)、5.3 数据关系说明(按表关系描述外键与一对多/多对多)。只描述提供的真实表与字段。全文 1000-1600 字。",
  },
  {
    key: "ch6-implementation",
    title: "第六章 系统实现",
    kinds: ["code", "architecture"],
    instruction:
      "撰写'第六章 系统实现',Markdown 含小节:6.1 开发环境与项目结构(依据目录结构)、6.2 核心功能实现(挑 3-5 个关键模块,结合真实源码描述实现思路,可引用 3-8 行关键代码片段)、6.3 关键技术处理(如拦截器/事务/异常处理等,必须有真实代码依据)。引用的代码必须来自提供的源码摘录,不得臆造。全文 1200-1800 字。",
  },
  {
    key: "ch7-testing",
    title: "第七章 系统测试",
    kinds: ["tests", "requirements"],
    instruction:
      "撰写'第七章 系统测试',Markdown 含小节:7.1 测试环境与工具、7.2 测试方案(说明单元/集成等测试策略)、7.3 测试用例与结果(依据真实测试记录,用表格列出代表性用例/预期/结果,给出通过率统计)、7.4 问题与修复(如有失败记录与修复提交)。数据必须来自测试记录,没有的不要编造。全文 800-1200 字。",
  },
  {
    key: "ch8-conclusion",
    title: "第八章 总结",
    kinds: ["project", "requirements", "tests", "git"],
    instruction:
      "撰写'第八章 总结与展望',Markdown 含小节:8.1 工作总结(项目完成情况,对照需求目标)、8.2 实现成果(功能与测试成果)、8.3 不足与改进(客观指出当前版本局限,可参考测试失败记录)、8.4 后续展望。全文 600-1000 字。",
  },
  {
    key: "references",
    title: "参考文献",
    kinds: ["project", "architecture"],
    instruction:
      "生成毕业论文参考文献列表(10-14 条,GB/T 7714 风格,编号[1]-[n])。围绕项目真实使用的技术(框架、语言、数据库)与软件工程主题组织,可为教材、技术书籍、规范文档等通用来源;这是 AI 辅助整理的候选列表,条目需用户人工核对后方可使用,不得编造 DOI/页码等精确信息。条目之间用空行分隔。",
  },
  {
    key: "acknowledgment",
    title: "致谢",
    kinds: ["project"],
    instruction:
      "撰写毕业论文致谢初稿(300-500 字):感谢指导教师、学院、同学与家人。语言真诚朴素,使用通用称谓(如'我的指导老师'),不编造具体人名;用户可自行修改补充真实姓名。",
  },
];

/** 其他文档类型的章节骨架 */
export const OTHER_DOC_SECTIONS: Record<string, SectionDef[]> = {
  OPENING_REPORT: [
    {
      key: "topic",
      title: "选题背景与意义",
      kinds: ["project", "requirements"],
      instruction:
        "撰写开题报告的'选题背景与意义'(500-800 字,Markdown):结合项目背景与需求说明选题价值。",
    },
    {
      key: "content",
      title: "主要研究内容与目标",
      kinds: ["requirements", "architecture"],
      instruction:
        "撰写'主要研究内容与目标'(500-800 字,Markdown):列出研究内容(对应功能模块)与预期目标(对应项目目标)。",
    },
    {
      key: "plan",
      title: "技术路线与进度安排",
      kinds: ["architecture", "git"],
      instruction:
        "撰写'技术路线与进度安排'(Markdown):技术路线按架构分层说明;进度安排给出 8-12 周的阶段划分表(需求分析→系统设计→编码→测试→论文撰写),用 Markdown 表格。",
    },
    {
      key: "refs",
      title: "参考文献",
      kinds: ["project", "architecture"],
      instruction: "参考文献候选列表(8-12 条,GB/T 7714 风格,AI 辅助整理,需人工核对)。",
    },
  ],
  TASK_BOOK: [
    {
      key: "task",
      title: "毕业设计任务内容",
      kinds: ["project", "requirements"],
      instruction:
        "撰写任务书的'设计任务与要求'(Markdown):任务内容(功能范围)、设计要求(技术要求与文档要求)。",
    },
    {
      key: "milestone",
      title: "进度与成果要求",
      kinds: ["git", "tests"],
      instruction:
        "撰写'进度安排与成果要求'(Markdown):阶段进度表(Markdown 表格)+ 需交付的成果清单(系统、说明书、测试报告等)。",
    },
  ],
  LITERATURE_REVIEW: [
    {
      key: "review",
      title: "文献综述正文",
      kinds: ["project", "architecture"],
      instruction:
        "撰写文献综述框架(800-1200 字,Markdown):围绕项目技术主题分 3-4 个综述方向(如前端框架演进、后端服务设计、数据库选型),每个方向说明研究现状与趋势;文末列出候选文献列表(GB/T 7714,AI 辅助整理,需人工核对)。",
    },
  ],
};

export function sectionDefsForType(type: string): SectionDef[] {
  if (type === "THESIS") return THESIS_SECTIONS;
  return OTHER_DOC_SECTIONS[type] ?? THESIS_SECTIONS;
}

/** 按章节定义生成内容。返回 { content, snapshot }。 */
export async function generateSectionContent(input: {
  projectId: string;
  userId: string;
  def: SectionDef;
  allSectionTitles: string[];
}): Promise<{ content: string; snapshot: DependencySnapshot }> {
  const { texts, snapshot } = await buildDocumentContext(
    input.projectId,
    input.userId,
    input.def.kinds,
  );

  let prompt: string;
  let system: string;

  if (input.def.special === "toc") {
    // 目录:程序化生成,不调 AI
    const toc = input.allSectionTitles
      .filter((t) => !/^目录$/.test(t))
      .map((t, i) => `${i + 1}. ${t}`)
      .join("\n");
    return { content: toc, snapshot };
  }

  if (input.def.special === "abstract-en") {
    const abstractRow = await db.documentSection.findFirst({
      where: { document: { projectId: input.projectId }, key: "abstract" },
      select: { content: true },
    });
    if (!abstractRow?.content.trim()) {
      throw new DocumentError("请先生成中文摘要,再生成英文摘要", "abstract_not_ready");
    }
    system =
      "你是学术英语翻译专家。把中文论文摘要翻译为学术英文 Abstract:术语准确、符合计算机学科论文表达、忠实原文技术事实,不添加原文没有的内容。只输出英文摘要正文(不写标题,末尾附 Keywords: 3-5 个)。";
    prompt = `## 中文摘要\n${abstractRow.content}`;
  } else {
    system =
      "你是计算机专业毕业论文写作助手。你必须只依据提供的真实项目数据写作:不得编造数据中没有的功能、技术、数字或引用;语言为学术简体中文,客观严谨;使用 Markdown 组织(小节标题用 ###,表格用 Markdown 表格,代码引用用代码块)。只输出正文内容,不要输出章节大标题以外的开场白。";
    prompt = `${joinContext(texts, input.def.kinds)}\n\n## 写作任务\n${input.def.instruction}\n\n论文其他章节标题(供行文呼应,不要展开写):${input.allSectionTitles.join("、")}`;
  }

  const result = await generateText({
    model: getChatModel(),
    system,
    prompt,
    maxOutputTokens: MAX_SECTION_TOKENS,
    abortSignal: AbortSignal.timeout(GEN_TIMEOUT_MS),
  });
  const content = (result.text ?? "").trim();
  if (!content) {
    throw new DocumentError("AI 未返回内容,请重试", "empty_output");
  }
  return { content, snapshot };
}

type EditMode = "polish" | "expand" | "condense";

const EDIT_PROMPTS: Record<EditMode, string> = {
  polish:
    "润色该章节:优化学术表达与语言结构,修正口语化表述,统一术语;技术事实、功能描述、数字数据必须与原文完全一致,不得增删事实内容。",
  expand:
    "扩写该章节:在不引入新事实的前提下,对已有技术点补充原理说明、实现细节与承接性论述;可以解释原文提及的技术与流程,但不得新增数据中没有的功能、技术或数字。",
  condense:
    "缩写该章节:删除重复表述与冗余过渡,合并啰嗦段落,保留全部关键事实(功能、技术、数据、结论);篇幅压缩到原文的一半左右。",
};

/** AI 编辑:润色 / 扩写 / 缩写(输入当前内容,输出完整新内容)。 */
export async function editSectionContent(input: {
  mode: EditMode;
  title: string;
  content: string;
  projectContext: string;
}): Promise<{ content: string; note: string }> {
  const result = await generateText({
    model: getChatModel(),
    system:
      "你是毕业论文编辑助手。对提供的章节内容执行指定编辑操作:保持 Markdown 结构,保持技术事实不变。直接输出编辑后的【完整】章节 Markdown 正文,不要 JSON、不要代码围栏、不要任何说明文字。",
    prompt: `## 项目背景(用于校准语境,不得引入其中没有的事实)\n${input.projectContext.slice(0, 2000)}\n\n## 章节:${input.title}\n\n${input.content.slice(0, 12_000)}\n\n## 编辑要求\n${EDIT_PROMPTS[input.mode]}`,
    maxOutputTokens: MAX_SECTION_TOKENS,
    abortSignal: AbortSignal.timeout(GEN_TIMEOUT_MS),
  });

  let text = (result.text ?? "").trim();
  if (!text) throw new DocumentError("AI 未返回内容,请重试", "empty_output");
  if (text.startsWith("```")) {
    text = text
      .replace(/^```(?:markdown)?\s*\n?/, "")
      .replace(/```\s*$/, "")
      .trim();
  }
  return { content: text, note: `${input.mode} 完成` };
}

/** 当前项目背景短文本(编辑时给 AI 校准语境)。 */
export async function buildShortProjectContext(projectId: string, userId: string): Promise<string> {
  const { texts } = await buildDocumentContext(projectId, userId, ["project"]);
  return texts.project ?? "";
}
