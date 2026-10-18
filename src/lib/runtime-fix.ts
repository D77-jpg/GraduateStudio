export const FIX_MESSAGE_LIMIT = 2000;
const PREFIX = "修复项目运行错误。请优先处理下方关键错误，结合工作区文件检查原因并修复相关代码：\n";

/** Keep actionable errors before stack frames while respecting the task API limit. */
export function buildRuntimeFixMessage(lines: Array<{ stream: string; text: string }>): string {
  const entries = lines
    .flatMap((line) =>
      line.text.split(/\r?\n/).map((text) => ({ stream: line.stream, text: text.trimEnd() })),
    )
    .filter((line) => line.text.trim());
  const unique = entries.filter(
    (line, index) => entries.findIndex((other) => other.text === line.text) === index,
  );
  const key = unique.filter((line) =>
    /failed to resolve|cannot find|does not exist|error:|syntaxerror|referenceerror|typeerror|exception|ENOENT/i.test(
      line.text,
    ),
  );
  const rest = unique.filter((line) => !key.includes(line));
  const excerpt =
    [...key.slice(-8), ...rest.slice(-20)]
      .map((line) => `[${line.stream}] ${line.text}`)
      .join("\n") || "（无明确错误输出，请检查项目入口文件、导入路径和运行配置。）";
  const budget = FIX_MESSAGE_LIMIT - PREFIX.length;
  const marker = "\n（日志过长，已截取；请结合项目文件定位。）";
  return (
    PREFIX + (excerpt.length > budget ? excerpt.slice(0, budget - marker.length) + marker : excerpt)
  );
}
