export type AcceptanceStatus = "passed" | "failed" | "blocked";
export type AcceptanceCheckStatus = AcceptanceStatus | "skipped";

export interface AcceptanceCheck {
  id: string;
  label: string;
  status: AcceptanceCheckStatus;
  command?: string;
  output: string;
  /** Measured elapsed time; omitted when execution timing was not recorded. */
  durationMs?: number;
  /** Failure-only evidence collected separately from bounded console output. */
  failureEvidence?: string;
  failureEvidenceIncomplete?: boolean;
}

/** Passed means engineering checks passed, NOT a deliverable/product certification. */
export interface AcceptanceReport {
  version: 1;
  status: AcceptanceStatus;
  checks: AcceptanceCheck[];
  limitations: string[];
}

export const ACCEPTANCE_LIMITATIONS = [
  "通过仅表示有限工程检查通过，不代表项目已具备完整交付条件。",
  "真实 API 行为、数据库连接、迁移、持久化与数据正确性未经验证。",
  "真实用户路径、推荐质量、端到端行为与人工验收未经验证。",
  "声明的构建/测试脚本及 Maven 插件会执行项目代码；已禁用 npm 生命周期钩子，但检查不是安全沙箱。",
];

export type AcceptanceCommandId =
  | "frontend-build"
  | "frontend-test"
  | "backend-verify"
  | "backend-build"
  | "backend-test"
  | "backend-syntax";
export interface AcceptanceCommand {
  id: AcceptanceCommandId;
  label: string;
  directory: "." | "client" | "server" | "backend";
  tool: "npm" | "mvn" | "node";
  args: readonly string[];
  timeoutMs: number;
}
export interface AcceptanceSnapshot {
  frontend?: { directory: "." | "client"; packageJson: unknown };
  backend: boolean;
  backendHasTests: boolean;
  nodeBackend?: { directory: "backend" | "server"; packageJson: unknown };
  sources: Array<{ path: string; content: string }>;
  inspectionErrors?: string[];
}
export interface AcceptancePlan {
  checks: AcceptanceCheck[];
  commands: AcceptanceCommand[];
}

export function summarizeAcceptance(checks: readonly AcceptanceCheck[]): AcceptanceStatus {
  if (checks.some((check) => check.status === "failed")) return "failed";
  if (!checks.length || checks.some((check) => check.status === "blocked")) return "blocked";
  return checks.some((check) => check.status === "passed") ? "passed" : "blocked";
}

/** Only conventional build entry points; do not treat echo/no-op scripts as builds. */
export function isSupportedBuildScript(script: unknown): boolean {
  return (
    typeof script === "string" &&
    /^(?:(?:tsc(?:\s+-b|\s+--noEmit)?|vue-tsc\s+--noEmit)\s*&&\s*)?(?:vite\s+build|next\s+build|react-scripts\s+build|vue-cli-service\s+build)(?:\s+--[\w-]+(?:=[\w./-]+)?)*\s*$/.test(
      script.trim(),
    )
  );
}

/** Recognize only a direct Vitest invocation, never a guessed or compound shell test. */
export function isVitestTestScript(script: unknown): boolean {
  return (
    typeof script === "string" &&
    !/--(?:passWithNoTests|watch|help|version|ui|list)\b/i.test(script) &&
    /^vitest(?:\s+(?:run|--[a-zA-Z][\w-]*(?:=[\w./-]+)?))*\s*$/.test(script.trim())
  );
}

/** Node tests are invoked with fixed arguments, not package-supplied paths or shell fragments. */
export function isNodeTestScript(script: unknown): boolean {
  return typeof script === "string" && /^node\s+--test\s*$/.test(script.trim());
}

export function isBackendTypeScriptBuild(script: unknown): boolean {
  return typeof script === "string" && /^tsc(?:\s+-b|\s+--noEmit)?\s*$/.test(script.trim());
}

/** Relative paths only, also safe when passed directly to node on Windows. */
export function isSafeNodeSourcePath(file: string): boolean {
  return (
    /^(?:[\w.-]+\/)*[\w.-]+\.(?:js|mjs|cjs)$/.test(file) &&
    !file.split("/").some((part) => part === "." || part === ".." || part.startsWith("-"))
  );
}

export function isNodeTestSource(file: string): boolean {
  return (
    /(?:^|\/)(?:tests?|__tests__)\/.*\.(?:[cm]?[jt]s)$/.test(file) ||
    /(?:^|\/)[^/]+\.(?:test|spec)\.(?:[cm]?[jt]s)$/.test(file)
  );
}

/** Explicit implementation disclaimers only; generic sample/mock words or bare TODOs are not evidence. */
export function detectAcceptancePlaceholders(sources: AcceptanceSnapshot["sources"]): string[] {
  const patterns = [
    /当前为本地演示数据/,
    /后续将接入/,
    /\bTODO\s*[:：-]?\s*(?:implement|connect|integrate)\s+(?:the\s+)?(?:real\s+)?(?:api|backend|database|authentication)\b/i,
    /TODO\s*[:：-]?\s*(?:接入真实(?:接口|数据|后端)|实现(?:登录|认证|数据库|后端接口))/i,
  ];
  return sources
    .flatMap(({ path, content }) => {
      const matches: string[] = [];
      content.split(/\r?\n/).forEach((line, index) => {
        if (patterns.some((pattern) => pattern.test(line))) {
          matches.push(`${path}:${index + 1}: ${line.trim().slice(0, 240)}`);
        }
      });
      return matches;
    })
    .slice(0, 30);
}

export function planProjectAcceptance(snapshot: AcceptanceSnapshot): AcceptancePlan {
  const checks: AcceptanceCheck[] = [];
  const commands: AcceptanceCommand[] = [];
  const record = (id: string, label: string, status: AcceptanceCheckStatus, output: string) =>
    checks.push({ id, label, status, output, durationMs: 0 });
  if (snapshot.inspectionErrors?.length) {
    record("inspection", "项目扫描", "blocked", snapshot.inspectionErrors.join("\n"));
  }
  if (!snapshot.frontend) {
    record(
      "frontend-build",
      "前端构建",
      "blocked",
      "未找到支持的 client/package.json 或根目录 package.json。",
    );
    record("frontend-test", "前端测试", "blocked", "未找到支持的前端测试。");
  } else {
    const pkg = snapshot.frontend.packageJson;
    const scripts =
      pkg && typeof pkg === "object" && "scripts" in pkg
        ? (pkg as { scripts?: unknown }).scripts
        : undefined;
    const scriptMap =
      scripts && typeof scripts === "object" ? (scripts as Record<string, unknown>) : {};
    if (isSupportedBuildScript(scriptMap.build)) {
      commands.push({
        id: "frontend-build",
        label: "前端构建",
        directory: snapshot.frontend.directory,
        tool: "npm",
        args: ["--ignore-scripts", "run", "build"],
        timeoutMs: 180_000,
      });
    } else
      record(
        "frontend-build",
        "前端构建",
        "blocked",
        "构建脚本缺失或无法识别；仅支持标准 Vite/Next/React/Vue 构建，不执行未知或空操作脚本。",
      );
    if (isVitestTestScript(scriptMap.test)) {
      commands.push({
        id: "frontend-test",
        label: "前端测试",
        directory: snapshot.frontend.directory,
        tool: "npm",
        args: ["--ignore-scripts", "run", "test", "--", "--run"],
        timeoutMs: 120_000,
      });
    } else
      record(
        "frontend-test",
        "前端测试",
        "blocked",
        scriptMap.test
          ? "测试脚本无法识别；仅支持直接运行 Vitest，未执行未知脚本。"
          : "未声明 test 测试脚本，无法证明测试通过。",
      );
  }
  if (snapshot.backend) {
    commands.push({
      id: "backend-verify",
      label: "后端 Maven 验证",
      directory: "server",
      tool: "mvn",
      args: ["-B", "-f", "pom.xml", "verify"],
      timeoutMs: 240_000,
    });
    if (!snapshot.backendHasTests)
      record(
        "backend-tests",
        "后端测试",
        "blocked",
        "server/src/test 下未找到测试源码；仅 Maven 成功不能证明测试通过。",
      );
  } else if (snapshot.nodeBackend) {
    const { directory, packageJson } = snapshot.nodeBackend;
    const pkg =
      packageJson && typeof packageJson === "object"
        ? (packageJson as {
            scripts?: Record<string, unknown>;
            devDependencies?: Record<string, unknown>;
            dependencies?: Record<string, unknown>;
          })
        : {};
    const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
    const localSources = snapshot.sources
      .filter((source) => source.path.startsWith(`${directory}/`))
      .map((source) => source.path.slice(directory.length + 1));
    if (scripts.build !== undefined) {
      if (
        isBackendTypeScriptBuild(scripts.build) &&
        (typeof pkg.devDependencies?.typescript === "string" ||
          typeof pkg.dependencies?.typescript === "string")
      ) {
        commands.push({
          id: "backend-build",
          label: "后端 TypeScript 构建",
          directory,
          tool: "npm",
          args: ["--ignore-scripts", "run", "build"],
          timeoutMs: 180_000,
        });
      } else
        record(
          "backend-build",
          "后端构建",
          "blocked",
          "后端 build 脚本无法识别；仅支持声明 TypeScript 依赖的直接 tsc 构建。",
        );
    } else {
      const files = localSources.filter(
        (file) => !isNodeTestSource(file) && isSafeNodeSourcePath(file),
      );
      if (
        !files.length ||
        files.length > 128 ||
        localSources.some(
          (file) =>
            !isNodeTestSource(file) &&
            (/\.(?:[cm]?tsx?)$/.test(file) ||
              (/\.(?:js|mjs|cjs)$/.test(file) && !isSafeNodeSourcePath(file))),
        )
      ) {
        record(
          "backend-syntax",
          "后端 JavaScript 语法检查",
          "blocked",
          "需要 1–128 个可安全检查的 JavaScript 源文件；TypeScript 后端必须声明受支持的构建。",
        );
      } else
        for (const file of files)
          commands.push({
            id: "backend-syntax",
            label: `后端语法 ${file}`,
            directory,
            tool: "node",
            args: ["--check", file],
            timeoutMs: 10_000,
          });
    }
    if (!localSources.some(isNodeTestSource)) {
      record(
        "backend-test",
        "后端测试",
        "blocked",
        "后端未找到测试源码；不能仅凭 test 脚本或退出码判定通过。",
      );
    } else if (isNodeTestScript(scripts.test)) {
      commands.push({
        id: "backend-test",
        label: "后端 Node 测试",
        directory,
        tool: "node",
        args: ["--test"],
        timeoutMs: 120_000,
      });
    } else if (isVitestTestScript(scripts.test)) {
      commands.push({
        id: "backend-test",
        label: "后端 Vitest 测试",
        directory,
        tool: "npm",
        args: ["--ignore-scripts", "run", "test", "--", "--run"],
        timeoutMs: 120_000,
      });
    } else
      record(
        "backend-test",
        "后端测试",
        "blocked",
        "未声明受支持的真实测试脚本；仅支持 node --test 或直接 Vitest，不执行未知或空操作脚本。",
      );
  } else
    record(
      "backend-verify",
      "后端工程验证",
      "blocked",
      "未找到支持的 server/pom.xml、backend/package.json 或 server/package.json 后端项目。",
    );
  const placeholders = detectAcceptancePlaceholders(snapshot.sources);
  record(
    "implementation-placeholders",
    "明确演示/待实现占位检查",
    placeholders.length ? "blocked" : "passed",
    placeholders.length
      ? placeholders.join("\n")
      : "有限源码扫描未发现明确演示/待实现占位标记；这不证明实现完整。",
  );
  return { checks, commands };
}
