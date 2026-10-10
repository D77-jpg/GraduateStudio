import { z } from "zod";
import { generateObjectCompat } from "@/server/ai/compat";

/**
 * Phase 10:答辩 AI 能力。
 * 出题/PPT 结构/回答评分(含追问判定)/评估报告,全部基于真实项目知识库。
 * 问题必须能从项目数据中找到依据(如"为什么选 JWT 而不是 Session"要有真实技术栈支撑)。
 */

const GEN_TIMEOUT_MS = 480_000;

export class DefenseError extends Error {
  code: string;
  constructor(message: string, code = "defense_error") {
    super(message);
    this.name = "DefenseError";
    this.code = code;
  }
}

const questionItemSchema = z.object({
  category: z
    .enum(["技术选型", "系统设计", "数据库", "测试质量", "实现细节", "创新与总结"])
    .describe("问题类别"),
  question: z.string().min(8).max(200).describe("答辩问题(简体中文,像答辩老师当面提问)"),
  expectedPoints: z
    .array(z.string().max(120))
    .min(2)
    .max(5)
    .describe("参考答案要点(依据项目真实情况)"),
  difficulty: z.enum(["基础", "进阶", "挑战"]),
});

const questionsOutputSchema = z.object({
  questions: z.array(questionItemSchema).min(6).max(12),
});

export type GeneratedQuestion = z.infer<typeof questionItemSchema>;

/** AI 生成答辩问题(必须依据真实技术栈/设计,给出参考答案要点)。 */
export async function generateDefenseQuestions(input: {
  knowledgeText: string;
  count: number;
  focus?: string;
}): Promise<GeneratedQuestion[]> {
  const result = await generateObjectCompat({
    system:
      "你是计算机毕业设计答辩评委。依据提供的真实项目数据出答辩问题:每个问题都要有项目数据依据(如项目用了 JWT 就可以问'为什么选 JWT 而不是 Session'),禁止问与项目无关的问题。expectedPoints 依据项目真实设计给出参考要点。只输出符合 JSON Schema 的内容。",
    prompt: `${input.knowledgeText.slice(0, 14_000)}\n\n## 任务\n出 ${input.count} 个答辩问题,覆盖技术选型/系统设计/数据库/测试质量/实现细节/创新与总结各类别${
      input.focus ? `,侧重:${input.focus}` : ""
    }。难度分布:基础约 1/3,进阶约 1/2,挑战少量。`,
    schema: questionsOutputSchema,
    schemaName: "DefenseQuestions",
    maxOutputTokens: 8_000,
    signal: AbortSignal.timeout(GEN_TIMEOUT_MS),
  });
  return result.questions;
}

const pptOutputSchema = z.object({
  title: z.string().describe("答辩 PPT 主标题"),
  slides: z
    .array(
      z.object({
        title: z.string().max(40).describe("页标题"),
        bullets: z.array(z.string().max(80)).min(2).max(6).describe("页面要点"),
        talkingPoints: z.string().max(300).describe("讲稿提示(讲什么、怎么讲)"),
        suggestedVisual: z
          .string()
          .max(60)
          .describe("建议配图/图表(如架构图、ER 图、测试通过率柱状图)"),
      }),
    )
    .min(10)
    .max(14),
});

export type PptOutline = z.infer<typeof pptOutputSchema>;

/** AI 生成答辩 PPT 结构(页标题+要点+讲稿提示+建议配图)。 */
export async function generatePptOutline(knowledgeText: string): Promise<PptOutline> {
  const result = await generateObjectCompat({
    system:
      "你是毕业答辩 PPT 设计专家。依据真实项目数据设计 10-14 页答辩 PPT 结构:封面→背景与意义→需求分析→系统架构→数据库设计→核心功能实现(2-3 页)→系统测试→创新点→总结与展望→致谢。bullets 只能写项目数据里存在的内容;talkingPoints 给出该页的讲法提示。只输出符合 JSON Schema 的内容。",
    prompt: knowledgeText.slice(0, 14_000),
    schema: pptOutputSchema,
    schemaName: "DefensePptOutline",
    maxOutputTokens: 12_000,
    signal: AbortSignal.timeout(GEN_TIMEOUT_MS),
  });
  return result;
}

const answerScoreSchema = z.object({
  technicalUnderstanding: z.number().int().min(0).max(100).describe("技术理解"),
  projectUnderstanding: z.number().int().min(0).max(100).describe("项目理解"),
  completeness: z.number().int().min(0).max(100).describe("回答完整度"),
  professionalism: z.number().int().min(0).max(100).describe("专业性"),
  clarity: z.number().int().min(0).max(100).describe("表达清晰度"),
  overall: z.number().int().min(0).max(100).describe("综合分"),
  comment: z.string().min(10).max(400).describe("评委点评:亮点 + 不足(简体中文)"),
  followup: z
    .object({ question: z.string().min(5).max(200), reason: z.string().max(120) })
    .nullable()
    .describe("需要追问时给出追问题与原因;不需要则 null"),
});

export type AnswerScore = z.infer<typeof answerScoreSchema>;

/** AI 评分一次回答(五维 + 综合 + 点评 + 追问判定)。追问不超过 1 层。 */
export async function scoreAnswer(input: {
  knowledgeText: string;
  question: string;
  category: string;
  expectedPoints: string[];
  answer: string;
  isFollowup: boolean;
}): Promise<AnswerScore> {
  const result = await generateObjectCompat({
    system:
      "你是计算机毕业设计答辩评委。依据项目真实情况与参考要点,对学生回答进行五维评分(0-100 整数)并给出综合分与点评。评分要客观:回答与项目事实不符要扣分,空白或跑题给低分。当回答明显含糊、关键点缺失或值得深挖时给出一个追问(仅当 isFollowup=false 时才允许追问,追问环节不再追问)。只输出符合 JSON Schema 的内容。",
    prompt: `${input.knowledgeText.slice(0, 10_000)}\n\n## 问题(${input.category}${input.isFollowup ? ",追问" : ""})\n${input.question}\n\n## 参考答案要点\n${input.expectedPoints.map((p) => `- ${p}`).join("\n")}\n\n## 学生回答\n${input.answer.slice(0, 4_000) || "(未作答)"}`,
    schema: answerScoreSchema,
    schemaName: "AnswerScore",
    maxOutputTokens: 4_000,
    signal: AbortSignal.timeout(GEN_TIMEOUT_MS),
  });
  // 追问环节不允许二级追问
  if (input.isFollowup && result.followup) {
    return { ...result, followup: null };
  }
  return result;
}

const reportOutputSchema = z.object({
  readiness: z.number().int().min(0).max(100).describe("答辩准备度评分(0-100)"),
  dimensions: z
    .array(
      z.object({
        name: z.string().max(20),
        score: z.number().int().min(0).max(100),
        comment: z.string().max(200),
      }),
    )
    .length(5)
    .describe("五个维度:技术理解/项目理解/回答完整度/专业性/表达清晰度"),
  weakPoints: z
    .array(
      z.object({
        area: z.string().max(40).describe("薄弱领域"),
        issue: z.string().max(200).describe("具体问题"),
        suggestion: z.string().max(200).describe("改进建议"),
      }),
    )
    .min(2)
    .max(5),
  summary: z.string().min(30).max(500).describe("总体评价与备考建议"),
});

export type DefenseReport = z.infer<typeof reportOutputSchema>;

/** AI 生成评估报告:准备度 + 五维 + 弱项分析。 */
export async function generateDefenseReport(input: {
  knowledgeText: string;
  turns: Array<{
    question: string;
    category: string;
    isFollowup: boolean;
    answer: string;
    scores: AnswerScore | null;
  }>;
}): Promise<DefenseReport> {
  const transcript = input.turns
    .map(
      (t, i) =>
        `### 问答 ${i + 1}(${t.category}${t.isFollowup ? ",追问" : ""})\n问题:${t.question}\n学生回答:${t.answer.slice(0, 1_200) || "(未作答)"}\n评分:${
          t.scores ? JSON.stringify(t.scores) : "(未评分)"
        }`,
    )
    .join("\n\n");
  const result = await generateObjectCompat({
    system:
      "你是答辩指导教师。依据模拟答辩全程记录,生成评估报告:五个维度分数(取各轮平均并微调,客观反映表现)、答辩准备度总分(综合五维与题目覆盖)、2-5 条弱项(具体到领域/问题/建议)、总体评价。只输出符合 JSON Schema 的内容。",
    prompt: `${input.knowledgeText.slice(0, 8_000)}\n\n## 模拟答辩记录\n${transcript.slice(0, 18_000)}`,
    schema: reportOutputSchema,
    schemaName: "DefenseReport",
    maxOutputTokens: 6_000,
    signal: AbortSignal.timeout(GEN_TIMEOUT_MS),
  });
  return result;
}
