import type { z } from "zod";

const fields = new Set([
  "title",
  "summary",
  "steps",
  "action",
  "path",
  "reason",
  "risks",
  "notes",
  "changes",
  "content",
  "modules",
  "id",
  "objective",
  "kind",
  "featureIds",
  "dependsOn",
  "acceptanceCriteria",
]);
/** Never include rejected values, arbitrary property names, or Zod's upstream message. */
export function summarizeSchemaIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path =
        issue.path
          .map((part) =>
            typeof part === "number"
              ? `[${part}]`
              : fields.has(String(part))
                ? String(part)
                : "未知字段",
          )
          .join(".")
          .replace(/\.\[/g, "[") || "根对象";
      let reason: string;
      switch (issue.code) {
        case "invalid_type":
          reason = `缺少必需字段或类型不正确（应为 ${["string", "number", "boolean", "array", "object", "null"].includes(issue.expected) ? issue.expected : "指定类型"}）`;
          break;
        case "invalid_value":
          reason = path.endsWith("action")
            ? "动作必须是 create、modify 或 delete"
            : "不在允许的选项中";
          break;
        case "too_small":
          reason = "内容为空或未达到必需的最小长度/数量";
          break;
        case "too_big":
          reason = "超过字段允许的长度/数量";
          break;
        case "invalid_format":
          reason = "格式不正确";
          break;
        default:
          reason = "不符合字段校验规则";
      }
      return `${path}：${reason}`;
    })
    .join("；");
}
