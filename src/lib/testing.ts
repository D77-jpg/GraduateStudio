import { z } from "zod";

/** Phase 7:测试中心领域模型(前后端共享)。 */

export const TEST_KINDS = ["unit", "api", "e2e", "permission"] as const;
export type TestKind = (typeof TEST_KINDS)[number];

export const TEST_KIND_LABELS: Record<TestKind, string> = {
  unit: "单元测试",
  api: "API 测试",
  e2e: "E2E 测试",
  permission: "权限测试",
};

export const TEST_RUN_STATUSES = ["running", "passed", "failed"] as const;
export type TestRunStatus = (typeof TEST_RUN_STATUSES)[number];

export const TEST_RESULT_STATUSES = ["passed", "failed", "skipped"] as const;
export type TestResultStatus = (typeof TEST_RESULT_STATUSES)[number];

export interface TestResultDto {
  id: string;
  name: string;
  suite: string;
  status: TestResultStatus;
  message: string;
  analysis: TestAnalysis | null;
  durationMs: number;
  ignored: boolean;
}

export interface TestAnalysis {
  error: string;
  stackTrace: string;
  relatedFile: string;
  relatedRequirement: string;
  possibleCause: string;
  suggestedFix: string;
}

export const testAnalysisSchema = z.object({
  error: z.string().max(600).describe("错误摘要"),
  stackTrace: z.string().max(600).describe("关键堆栈帧,可为空字符串"),
  relatedFile: z.string().max(200).describe("最可能的相关源文件路径"),
  relatedRequirement: z.string().max(300).describe("关联的需求/功能点"),
  possibleCause: z.string().max(600).describe("可能的根因分析"),
  suggestedFix: z.string().max(600).describe("建议的修复方向"),
});

export const testRunDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: z.enum(TEST_KINDS),
  status: z.enum(TEST_RUN_STATUSES),
  command: z.string(),
  total: z.number().int(),
  passed: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
  output: z.string(),
  durationMs: z.number().int(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  results: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      suite: z.string(),
      status: z.enum(TEST_RESULT_STATUSES),
      message: z.string(),
      analysis: testAnalysisSchema.nullable(),
      durationMs: z.number().int(),
      ignored: z.boolean(),
    }),
  ),
});

export type TestRunDto = z.infer<typeof testRunDtoSchema>;

/** AI 生成的测试文件 */
export const generatedTestSchema = z.object({
  notes: z.string().max(500).describe("生成说明:覆盖了哪些需求点"),
  files: z
    .array(
      z.object({
        path: z
          .string()
          .min(1)
          .max(200)
          .describe("相对路径,放在 client/tests/ 下,如 client/tests/auth.test.js"),
        content: z.string().min(1).describe("完整测试文件内容(Vitest + describe/it/expect)"),
      }),
    )
    .min(1)
    .max(8),
});

/** AI 失败分析输出 */
export const failureAnalysisOutputSchema = z.object({
  results: z
    .array(
      z.object({
        testName: z.string(),
        analysis: testAnalysisSchema,
      }),
    )
    .min(1),
});

/** AI 测试修复输出 */
export const testFixOutputSchema = z.object({
  explanation: z.string().max(500).describe("修复说明:改了什么、为什么"),
  target: z.enum(["code", "test"]).describe("code=修被测代码,test=修测试本身"),
  path: z.string().min(1).max(200),
  content: z.string().min(1).describe("修复后的完整文件内容"),
});
