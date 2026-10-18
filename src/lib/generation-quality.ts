import type { ChangeAction } from "./develop";

export class GenerationQualityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationQualityError";
  }
}

type PlannedFile = { path: string; action: ChangeAction };
type GeneratedFile = PlannedFile & { content: string };

/** Reject rather than normalize: the confirmed plan and output must name the same safe file. */
export function assertSafeGenerationPath(path: string): void {
  const segments = path.split("/");
  const protectedNames = new Set([
    "node_modules",
    ".git",
    ".next",
    "dist",
    "build",
    "__pycache__",
    ".venv",
    "venv",
  ]);
  if (
    !path ||
    path !== path.trim() ||
    path.length > 200 ||
    /[\\\u0000-\u001f\u007f:*?"<>|]/.test(path) ||
    segments.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[. ]$/.test(part) ||
        protectedNames.has(part.toLowerCase()) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  ) {
    throw new GenerationQualityError(`不安全的生成路径:${path}`);
  }
}

export function assertGenerationPlan(steps: readonly PlannedFile[]): void {
  if (!steps.length) {
    throw new GenerationQualityError("计划必须包含至少一个文件");
  }
  const seen = new Set<string>();
  for (const step of steps) {
    assertSafeGenerationPath(step.path);
    const key = step.path.toLowerCase();
    if (seen.has(key)) throw new GenerationQualityError(`计划路径重复:${step.path}`);
    seen.add(key);
    if (!["create", "modify", "delete"].includes(step.action)) {
      throw new GenerationQualityError(`非法计划动作:${step.action}`);
    }
  }
}

/** Deliberately conservative: reject obvious whole-file placeholders, not TODOs in real code. */
export function isPlaceholderOnly(content: string, path?: string): boolean {
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[^]*?-->/g, "")
    .replace(/^\s*(?:\/\/|#|--).*$/gm, "")
    .trim();
  if (!stripped) {
    // Comments are meaningful in docs/config (e.g. .gitignore, LICENSE, README headings).
    // Explicit placeholder comments are still rejected everywhere.
    if (
      /\b(?:TODO|TBD|FIXME|placeholder)\b|待实现|待补充|省略|implementation omitted/i.test(content)
    )
      return true;
    return (
      !path ||
      /\.(?:[cm]?[jt]sx?|py|java|kt|go|rs|c|cpp|h|cs|php|rb|swift|vue|svelte|sql)$/i.test(path)
    );
  }
  if (
    /^(?:TODO|TBD|FIXME|placeholder|待实现|待补充|此处省略|代码省略|\.\.\.|…)[\s.!。;]*$/i.test(
      stripped,
    )
  )
    return true;
  // Single stub module/function whose only executable body is an explicit unimplemented error.
  if (stripped.length < 600 && /(?:not implemented|未实现|待实现)/i.test(stripped)) {
    return (
      /^(?:export\s+)?(?:async\s+)?function\s+\w+\s*\([^)]*\)(?:\s*:\s*[\w<>\[\]| ]+)?\s*\{\s*throw\s+new\s+Error\(["'][^"']*["']\);?\s*\}\s*;?$/.test(
        stripped,
      ) || /^throw\s+new\s+Error\(["'][^"']*["']\);?$/.test(stripped)
    );
  }
  return /^def\s+\w+\([^)]*\):\s*(?:pass|\.\.\.)$/.test(stripped);
}

export function assertImplementationCoverage(
  steps: readonly PlannedFile[],
  changes: readonly GeneratedFile[],
): void {
  assertGenerationPlan(steps);
  const planned = new Map(steps.map((step) => [step.path, step.action]));
  const seen = new Set<string>();
  for (const change of changes) {
    assertSafeGenerationPath(change.path);
    const key = change.path.toLowerCase();
    if (seen.has(key)) throw new GenerationQualityError(`实现路径重复:${change.path}`);
    seen.add(key);
    if (!planned.has(change.path))
      throw new GenerationQualityError(`实现包含计划外文件:${change.path}`);
    if (planned.get(change.path) !== change.action)
      throw new GenerationQualityError(`实现动作与计划不一致:${change.path}`);
    if (change.action === "delete") {
      if (change.content !== "")
        throw new GenerationQualityError(`删除文件的 content 必须为空:${change.path}`);
    } else if (!change.content.trim() || isPlaceholderOnly(change.content, change.path)) {
      throw new GenerationQualityError(`实现为空或仅包含占位内容:${change.path}`);
    }
  }
  const missing = steps.filter((step) => !changes.some((change) => change.path === step.path));
  if (missing.length)
    throw new GenerationQualityError(
      `实现遗漏计划文件:${missing.map((step) => step.path).join("、")}`,
    );
}

/** Stable priorities ensure planning sees manifests, entries, API contracts and schemas first. */
export function prioritizePlanningFiles(paths: readonly string[]): string[] {
  const rank = (path: string): number => {
    if (
      /(^|\/)(package\.json|pyproject\.toml|requirements\.txt|pom\.xml|build\.gradle|go\.mod|Cargo\.toml)$/i.test(
        path,
      )
    )
      return 0;
    if (
      /(^|\/)(schema\.prisma|schema\.[^/]+|[^/]*schema[^/]*|openapi[^/]*|swagger[^/]*)$/i.test(
        path,
      ) ||
      /(^|\/)(migrations|models)\//i.test(path)
    )
      return 1;
    if (/(^|\/)(main|index|app|server|page|layout)\.[^/]+$/i.test(path)) return 2;
    if (
      /(^|\/)(api|routes|controllers)\//i.test(path) ||
      /(^|\/)(db|database|auth)\.[^/]+$/i.test(path)
    )
      return 3;
    return 4;
  };
  return [...new Set(paths)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export function assertFullRewriteContext(
  path: string,
  file: { content: string; truncated: boolean } | null,
  _remaining?: number,
): void {
  void _remaining;
  if (!file) throw new GenerationQualityError(`无法读取待修改文件完整内容:${path}`);
  if (file.truncated || file.content.includes("\u0000")) {
    throw new GenerationQualityError(
      `待修改文件读取结果被截断或不可作为文本读取:${path};禁止基于截断内容重写`,
    );
  }
}
