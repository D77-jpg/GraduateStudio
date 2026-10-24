import {
  PROJECT_TYPE_LABELS,
  DIFFICULTY_LABELS,
  type Difficulty,
  type ProjectType,
} from "@/lib/projects";
import type { TopicProposalOutput } from "./schemas";

const SYSTEM_PROMPT = `你是资深的计算机专业毕业设计指导老师,兼具软件架构经验。
你的输出面向中国本科计算机毕业设计:选题难度适中、功能规模可实现、论文好写、答辩好讲。
严格遵守:只输出符合给定 JSON Schema 的内容;所有文本使用简体中文;不要输出 Schema 之外的字段。`;

export function topicProposalPrompt(input: {
  idea: string;
  type?: string;
  devLanguage?: string;
  database?: string;
  difficulty?: string;
  needsAi?: boolean;
}): { system: string; prompt: string } {
  const prefs: string[] = [];
  if (input.type)
    prefs.push(`项目类型倾向:${PROJECT_TYPE_LABELS[input.type as ProjectType] ?? input.type}`);
  if (input.devLanguage) prefs.push(`开发语言倾向:${input.devLanguage}`);
  if (input.database) prefs.push(`数据库倾向:${input.database}`);
  if (input.difficulty)
    prefs.push(`难度倾向:${DIFFICULTY_LABELS[input.difficulty as Difficulty] ?? input.difficulty}`);
  if (input.needsAi)
    prefs.push("希望项目包含 AI 能力(如推荐算法、图像识别、智能问答等,规模要适合毕业设计)");

  return {
    system: SYSTEM_PROMPT,
    prompt: `学生提出了一个模糊的毕业设计想法,请生成一个完整的选题方案。

学生想法:${input.idea}
${prefs.length > 0 ? `\n偏好约束:\n- ${prefs.join("\n- ")}` : ""}

要求:
1. 项目名称采用论文标题风格:「基于 X 的 Y 设计与实现」。
2. 评分要校准、有区分度:不要全部打 80-90;实现难度评分反映真实工作量。
3. 技术栈给出具体版本无关的技术名(如 Vue 3、Spring Boot、MySQL),不要给泛泛的「前端框架」。
4. 若学生想法过于宽泛,收窄到一个可完成的范围;若与常见选题重复,在创新点上体现差异化。`,
  };
}

export function requirementPrompt(project: {
  name: string;
  description: string | null;
  type: string;
  techStack: string[];
  difficulty: string | null;
  background?: string | null;
  goals?: string[];
}): { system: string; prompt: string } {
  return {
    system: SYSTEM_PROMPT,
    prompt: `请为以下毕业设计项目生成结构化需求分析。

项目名称:${project.name}
项目简介:${project.description ?? "(未填写)"}
项目类型:${PROJECT_TYPE_LABELS[project.type as ProjectType] ?? project.type}
技术栈:${project.techStack.join("、") || "(未定)"}
难度:${project.difficulty ? (DIFFICULTY_LABELS[project.difficulty as Difficulty] ?? project.difficulty) : "(未定)"}
${project.background ? `项目背景:${project.background}` : ""}
${project.goals?.length ? `项目目标:\n- ${project.goals.join("\n- ")}` : ""}

要求:
1. 功能模块 4-10 个,每个模块包含 2-8 个功能点;覆盖核心业务 + 用户系统 + 管理后台,规模匹配毕业设计工作量。
2. 核心业务流程 2-6 条,要与功能模块呼应,步骤具体可执行(每条 2-8 步)。
3. 非功能需求 3-8 条,覆盖性能、安全、易用性等维度,条目具体(不要写「性能要好」这种空话)。
4. 系统边界明确:inScope 与 outOfScope 各 2-6 条,inScope 写本次要做的,outOfScope 写明确不做的(避免论文答辩时被质疑范围失控)。
5. 开发任务列表 4-12 条,按实现顺序排列:先基础设施,再核心功能,最后管理与统计。
6. 用户角色 2-5 个,项目目标 3-6 条。
7. 严格遵守上面的条数上限:条目过多会让结构化校验直接失败,合并同类项而不是罗列细枝末节。`,
  };
}

export function moduleRegeneratePrompt(input: {
  project: { name: string; type: string; techStack: string[] };
  moduleName: string;
  moduleDescription: string;
  siblingModules: string[];
}): { system: string; prompt: string } {
  return {
    system: SYSTEM_PROMPT,
    prompt: `请为毕业设计项目重新生成一个功能模块的功能点。

项目名称:${input.project.name}
项目类型:${PROJECT_TYPE_LABELS[input.project.type as ProjectType] ?? input.project.type}
技术栈:${input.project.techStack.join("、") || "(未定)"}

待重新生成的模块:${input.moduleName}
${input.moduleDescription ? `模块描述:${input.moduleDescription}` : ""}
其他模块(生成的功能点不要与它们重复):${input.siblingModules.join("、") || "(无)"}

要求:生成 2-8 个功能点,与项目技术栈匹配,粒度适中(每个功能点对应一个可开发、可演示的功能)。`,
  };
}

export function describeProposal(proposal: TopicProposalOutput): string {
  return `${proposal.name}(综合 ${proposal.overall} 分)`;
}
