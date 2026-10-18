import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AiOutputFormatError,
  CompatGenerateError,
  extractOutputJson,
} from "@/server/ai/output-json";

const schema = z.object({
  title: z.string(),
  changes: z.array(z.object({ path: z.string(), content: z.string() })),
});
const plan = (content = "exact content") => ({
  title: "plan",
  changes: [{ path: "src/example.ts", content }],
});
const json = JSON.stringify(plan());

function failure(text: string) {
  try {
    extractOutputJson(text, schema);
    throw new Error("Expected output failure");
  } catch (error) {
    expect(error).toBeInstanceOf(AiOutputFormatError);
    expect(error).toBeInstanceOf(CompatGenerateError);
    return error as AiOutputFormatError;
  }
}

describe("deterministic complete schema-aware root extraction", () => {
  it("preserves every byte of 100k+ content with braces, embedded fences, quotes and escapes", () => {
    const content =
      'const s = "{ brace }";\\path\n```json\n{"nested":true}\n```\n\t中文\r\n'.repeat(2_000);
    const expected = plan(content);
    const text = `说明：\n\`\`\`json\n${JSON.stringify(expected)}\n\`\`\``;
    expect(text.length).toBeGreaterThan(100_000);
    expect(extractOutputJson(text, schema)).toEqual(expected);
    expect(extractOutputJson(JSON.stringify(expected), schema).changes[0].content).toBe(content);
  });
  it.each([
    `{}\n${json}`,
    `说明 {}，下面是结果：\n${json}`,
    `{"irrelevant":"data"}\n\`\`\`json\n${json}\n\`\`\``,
    `before ${json} after`,
    `prose { unmatched prefix\n\`\`\`json\n${json}\n\`\`\``,
    `prose { unmatched prefix\n${json}`,
  ])("selects the schema-valid outer root among unrelated prose roots", (text) => {
    expect(extractOutputJson(text, schema)).toEqual(plan());
  });
  it("does not count the same root twice via entire-output and fenced paths", () => {
    expect(extractOutputJson(`\`\`\`json\n${json}\n\`\`\``, schema)).toEqual(plan());
  });
  it.each([`${json}\n${json}`, `${json}\n${JSON.stringify(plan("different"))}`])(
    "rejects multiple matching roots even if identical",
    (text) => {
      const error = failure(text);
      expect(error.kind).toBe("json");
      expect(error.message).toContain("歧义");
      expect(error.message).toContain("匹配 2");
    },
  );
  it.each([
    JSON.stringify({ wrapper: plan() }),
    `[${json}]`,
    `{"wrapper":${json}`,
    `{"title":"plan","changes":[${JSON.stringify(plan().changes[0])}`,
  ])("never promotes nested/array/truncated partial roots", (text) => {
    failure(text);
  });
  it.each([
    '{"title":"secret-value","changes":[],}',
    '{"title":"secret-value\\q","changes":[]}',
    '{"title":"secret-value\nraw control","changes":[]}',
    '{"title":"secret-value","changes":[',
    '{"title":"secret-value',
  ])("never repairs commas, invalid escapes, controls or truncation", (text) => {
    const error = failure(text);
    expect(error.kind).toBe("json");
    expect(error.message).not.toMatch(/secret-value|raw control/);
  });
  it("reports only numeric parser locations and structural flags", () => {
    const error = failure('{"title":"secret-value","changes":[],}');
    expect(error.message).toMatch(/解析偏移 \d+/);
    expect(error.message).not.toContain("secret-value");
    expect(failure('{"title":"secret-value').message).toContain("字符串未闭合=1");
    expect(failure('{"title":"secret-value","changes":[').message).toContain("缺少闭合=1");
  });
  it("retains safe schema field diagnoses without rejected names or values", () => {
    const error = failure('{"title":123,"changes":[{"path":"secret-name","content":123}]}');
    expect(error.kind).toBe("schema");
    expect(error.message).toContain("changes[0].content");
    expect(error.message).not.toContain("secret-name");
  });
  it.each([`${json}\n{"changes":`, `${json}\n{`, `{"changes":\n\`\`\`json\n${json}\n\`\`\``])(
    "does not discard an additional incomplete JSON root",
    (text) => {
      expect(failure(text).message).toContain("不能安全忽略");
    },
  );
  it("allows an unrelated trailing prose brace without losing the complete root", () => {
    expect(extractOutputJson(`${json}\n说明 { unfinished prose`, schema)).toEqual(plan());
  });
  it("does not repeatedly scan suffixes or impose a candidate/character quota", () => {
    const text = "{}\n".repeat(20_000) + json;
    expect(extractOutputJson(text, schema)).toEqual(plan());
  });
});
