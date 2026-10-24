import fs from "node:fs/promises";
import path from "node:path";

/**
 * 技术栈识别。交付闸门的第一原则：工作区里出现了哪种工程标记文件，就必须出现对应的
 * 已执行检查；识别到但没有检查器的栈一律 blocked，绝不静默忽略（旧版只认 package.json，
 * 导致 server/pom.xml 下 217 个 Java 文件从报告中“消失”，整体仍报 passed）。
 */

export type MarkerKind = "node" | "maven" | "gradle" | "python" | "go" | "rust" | "php" | "dotnet";

export interface StackMarker {
  /** 相对项目根的目录，"" 表示根目录。 */
  root: string;
  file: string;
  kind: MarkerKind;
}

/** 平台能真正执行检查的标记类型；其余识别到即 blocked。 */
export const SUPPORTED_KINDS: ReadonlySet<MarkerKind> = new Set(["node", "maven", "python"]);

/** 扫描的候选目录。比旧版 ROOTS 多了 frontend/web/api，覆盖常见生成布局。 */
export const STACK_ROOTS = ["", "client", "frontend", "web", "server", "backend", "api"] as const;

const MARKER_FILES: Array<{ file: string; kind: MarkerKind }> = [
  { file: "package.json", kind: "node" },
  { file: "pom.xml", kind: "maven" },
  { file: "build.gradle", kind: "gradle" },
  { file: "build.gradle.kts", kind: "gradle" },
  { file: "pyproject.toml", kind: "python" },
  { file: "requirements.txt", kind: "python" },
  { file: "go.mod", kind: "go" },
  { file: "Cargo.toml", kind: "rust" },
  { file: "composer.json", kind: "php" },
];

async function isPlainFile(file: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function hasCsproj(directory: string): Promise<string | null> {
  try {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }))
      if (entry.isFile() && /\.csproj$/i.test(entry.name)) return entry.name;
  } catch {
    /* absent */
  }
  return null;
}

/** 返回所有识别到的工程标记（同一目录同一类型只记一次）。 */
export async function scanStackMarkers(projectRoot: string): Promise<StackMarker[]> {
  const markers: StackMarker[] = [];
  for (const root of STACK_ROOTS) {
    const directory = path.join(projectRoot, root);
    const seen = new Set<MarkerKind>();
    for (const { file, kind } of MARKER_FILES) {
      if (seen.has(kind)) continue;
      if (await isPlainFile(path.join(directory, file))) {
        markers.push({ root, file, kind });
        seen.add(kind);
      }
    }
    const csproj = await hasCsproj(directory);
    if (csproj) markers.push({ root, file: csproj, kind: "dotnet" });
  }
  // 根目录 package.json 只在没有任何子目录 Node 工程时才算独立工程：
  // 很多生成项目的根 package.json 只是 concurrently 之类的启动聚合器。
  const nodeSubroots = markers.filter((m) => m.kind === "node" && m.root !== "");
  return nodeSubroots.length
    ? markers.filter((m) => !(m.kind === "node" && m.root === ""))
    : markers;
}

export function unsupportedMarkers(markers: StackMarker[]): StackMarker[] {
  return markers.filter((m) => !SUPPORTED_KINDS.has(m.kind));
}

export type StackProfileId = "vue-spring-mysql" | "vue-fastapi" | "node-fullstack";

export interface StackProfile {
  id: StackProfileId;
  title: string;
  /** resources/templates/<template>；没有模板的栈由骨架模块按约定补齐。 */
  template: string | null;
  /** 带对应工具链的 Codex worker 镜像（环境变量可覆盖）；不存在时回退基础镜像。 */
  workerImage: string;
}

export const STACK_PROFILES: Record<StackProfileId, StackProfile> = {
  "vue-spring-mysql": {
    id: "vue-spring-mysql",
    title: "Vue 3 + Spring Boot 3 + MySQL 8",
    template: "vue-spring-mysql",
    workerImage: process.env.GS_CODEX_WORKER_IMAGE_JAVA?.trim() || "gs-codex-worker-java:0.150.1",
  },
  "vue-fastapi": {
    id: "vue-fastapi",
    title: "Vue 3 + FastAPI",
    template: null,
    workerImage: process.env.GS_CODEX_WORKER_IMAGE_PYTHON?.trim() || "gs-codex-worker:0.150.1",
  },
  "node-fullstack": {
    id: "node-fullstack",
    title: "Node 全栈（Next.js / Express 等）",
    template: null,
    workerImage: "gs-codex-worker:0.150.1",
  },
};

/** 依据用户在选题/架构阶段确定的技术栈文本选择档案；无法判断时返回 null（不猜）。 */
export function resolveProfileFromText(texts: string[]): StackProfile | null {
  const text = texts.join("\n").toLowerCase();
  if (/spring\s*boot|springboot|spring-boot|\bjava\b|mybatis/.test(text))
    return STACK_PROFILES["vue-spring-mysql"];
  if (/fastapi|flask|django|\bpython\b/.test(text)) return STACK_PROFILES["vue-fastapi"];
  if (/next\.?js|express|nestjs|koa|node\.?js/.test(text)) return STACK_PROFILES["node-fullstack"];
  return null;
}

/** 已有工程时，以实际文件为准而不是以声明为准。 */
export function resolveProfileFromMarkers(markers: StackMarker[]): StackProfile | null {
  if (markers.some((m) => m.kind === "maven")) return STACK_PROFILES["vue-spring-mysql"];
  if (markers.some((m) => m.kind === "python")) return STACK_PROFILES["vue-fastapi"];
  if (markers.some((m) => m.kind === "node")) return STACK_PROFILES["node-fullstack"];
  return null;
}
