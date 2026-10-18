import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const DESIGN_REPORT_MARKER = "DESIGN_REPORT\n";
export type DesignMode = "full" | "local";
export interface DesignRequest {
  mode: DesignMode;
  message: string;
  uiOnly?: boolean;
}
export interface DesignPolicy {
  required: boolean;
  scope: { client: true };
}

/** Local maintenance does not acquire a design gate just because it mentions a page. */
export function getDesignPolicy({ mode, message, uiOnly }: DesignRequest): DesignPolicy {
  const clauses = message.split(/[。！？!?；;\n]/).map((part) => part.trim());
  const uiScopeRequest =
    Boolean(uiOnly) &&
    !/(?:不要|无需|不需要|禁止|不做|不修改|不调整|不设计|不美化|不改|勿).*(?:UI|界面|页面|前端|样式|布局|视觉)/i.test(
      message,
    ) &&
    !/(?:修复|维修|排查|repair|debug|fix)/i.test(message);
  const required =
    mode === "full" ||
    uiScopeRequest ||
    clauses.some((clause) => {
      if (
        /(?:不要|无需|不需要|禁止|不做|不修改|不调整|不设计|不美化|不改|勿|without|do not|don't|no)\s*(?:重新)?(?:设计|修改|调整|美化|redesign|change)?\s*(?:任何|已有)?\s*(?:UI|界面|页面|前端|样式|布局|视觉|design|styling)/i.test(
          clause,
        )
      )
        return false;
      // A backend repair with incidental UI symptoms is not an affirmative design request.
      if (
        /(?:后端|服务端|数据库|接口|backend|server|database|\bapi\b)/i.test(clause) &&
        !/(?:设计|美化|重做|重构|调整|优化|新增|创建|实现|增加|修改|修复|design|redesign|create|style|improve)\s*(?:一个|新的|现有|此|该|the|a)?\s*(?:UI|界面|页面|前端|样式|布局|视觉|配色|字体|组件|dashboard|landing page)/i.test(
          clause,
        )
      )
        return false;
      return (
        /(?:UI|界面|页面|前端|样式|布局|视觉|配色|字体|组件|dashboard|landing page)/i.test(
          clause,
        ) &&
        (/(?:设计|美化|重做|重构|调整|优化|新增|创建|实现|增加|修改|建设|design|redesign|create|style|improve|build)/i.test(
          clause,
        ) ||
          /(?:修复|fix).*(?:样式|布局|视觉|配色|字体|styling|layout|color|typography)/i.test(
            clause,
          ))
      );
    });
  return { required, scope: { client: true } };
}

export function designSystemPath(uiOnly = false): string {
  return uiOnly ? "client/design-system" : "design-system";
}

export function buildDesignInstructions(
  input: DesignRequest & {
    stage: "planning" | "implementation" | "repair";
  },
): string {
  if (!getDesignPolicy(input).required) return "";
  const root = designSystemPath(input.uiOnly);
  const stage =
    input.stage === "planning"
      ? "planning：先产出或补齐设计规范文件，不改业务代码。规范校验失败时先修正规范，不可进入新 UI 提议或实现。"
      : input.stage === "implementation"
        ? "implementation：每一轮先读取 MASTER.md、tokens.json 和相关 pages/*.md，再按规范实现；缺失或无效则先补齐规范，不可绕过校验提出新 UI。"
        : "repair：每轮读取并尊重已有规范，只修复当前问题，不重新设计、不擅自统一换色；不得给无设计要求的旧业务维修任务强加人工设计验收。";
  return [
    "【真实设计规范与证据约束】设计范围 scope.client=true，仅约束客户端 UI，不扩张至后端业务。",
    "只读使用 /opt/gs-design-skills 中的 UI UX Pro Max（离线 python search）与 frontend-design；先读取实际 SKILL.md，搜索命令 python3 -B /opt/gs-design-skills/ui-ux-pro-max/scripts/search.py '选题 用户 主任务' --design-system。禁止 --persist，搜索只输出 stdout，审计内容后自行写入工作区规范；禁止修改技能目录、网络访问、安装依赖或假称已经使用技能。字体使用已有本地字体及系统回退，不下载远程字体。技能不可用须如实说明，固定 id/revision 仅表示提供的版本，不证明执行。",
    "先明确选题、目标用户、用户主任务与差异化信息布局，再决定视觉方向；设计必须基于选题和任务，不是通用后台模板或统一换色。优先读取、尊重和延续已有规范；修改必须说明与选题的联系。",
    "检索结果只是候选，不是需求或最终设计。核对 category/source_identities 是否与选题、用户和主任务一致；误分类时拒绝不相关约束（例如电商创作不得引入药房处方或课表）。改用明确产品类型和 --domain style/ux、--stack vue/react 等定向检索；在 MASTER.md 记录采纳与拒绝理由。不要把营销落地页 hero/转化区套进业务工作台。",
    `规范目录：${root}。必须产出 MASTER.md、tokens.json、pages/*.md（至少一个页面规范）。`,
    "MASTER.md 使用独立非空字段：主题、用户、主任务、布局、反模板、字体、配色（如“主题：校园预约服务”或同名 Markdown 标题加正文）。反模板说明如何避免千篇一律；字体包含回退，配色说明用途。",
    'tokens.json 固定 schema：{"version":1,"colors":{"background":"#ffffff","foreground":"#111111","primary":"#245568"},"typography":{"fontFamily":"system-ui, sans-serif","headingFamily":"system-ui, sans-serif"},"spacing":{"sm":"4px","md":"8px","lg":"16px"},"radius":{"sm":"4px","md":"8px"}}；只允许这些字段，颜色为 #RRGGBB，尺寸为 0 或不大于256的 px/rem 数值。实际值须按选题选择，示例不是统一模板。',
    "pages/*.md 使用安全文件名，至少一份非空页面规范，说明页面主任务、布局、关键交互、响应式和无障碍；不能以空文件占位。",
    stage,
    "规范文件校验仅证明 specified，不代表视觉验收。当前没有可用的真实浏览器截图设施，不负责自动截图；必须保持 visual.status=not_run、reason=未执行真实浏览器截图视觉检查。不可虚构截图、已使用技能、视觉通过或测试通过；模型自行写的通过结论不是证据。",
  ].join("\n");
}

export interface DesignEvidence {
  version: 1;
  status: "specified" | "missing" | "invalid" | "not_required";
  artifacts: { path: string; sha256: string }[];
  issues: string[];
  visual: { status: "not_run"; reason: "未执行真实浏览器截图视觉检查" };
}
export interface DesignEvidenceOptions {
  required: boolean;
  uiOnly?: boolean;
  /** Offered immutable skill identities, never evidence of execution; not copied into the report. */
  bundle?: readonly { id: string; revision: string }[];
}
export const DESIGN_EVIDENCE_LIMITS = Object.freeze({
  fileBytes: 64 * 1024,
  totalBytes: 512 * 1024,
  pages: 32,
});
const MASTER_FIELDS = ["主题", "用户", "主任务", "布局", "反模板", "字体", "配色"];

function hasMasterField(text: string, field: string): boolean {
  const lines = text.split(/\r?\n/);
  return lines.some((line, index) => {
    const direct = new RegExp(
      `^\\s*(?:[-*]\\s+)?(?:\\*\\*)?${field}(?:\\*\\*)?\\s*[:：]\\s*(.+)$`,
    ).exec(line);
    if (direct) return Boolean(direct[1].replace(/[\s*#_-]/g, ""));
    if (!new RegExp(`^#{1,6}\\s+${field}\\s*$`).test(line)) return false;
    for (let next = index + 1; next < lines.length && !/^\s*#/.test(lines[next]); next++) {
      if (lines[next].replace(/[\s*_-]/g, "")) return true;
    }
    return false;
  });
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}
function validTokens(value: unknown): boolean {
  if (
    !record(value) ||
    !exactKeys(value, ["version", "colors", "typography", "spacing", "radius"]) ||
    value.version !== 1
  )
    return false;
  const sections = [
    ["colors", ["background", "foreground", "primary"], (v: string) => /^#[\da-f]{6}$/i.test(v)],
    [
      "typography",
      ["fontFamily", "headingFamily"],
      (v: string) => v.trim().length > 0 && v.length <= 200 && !/[\x00-\x1f]/.test(v),
    ],
    ["spacing", ["sm", "md", "lg"], validSize],
    ["radius", ["sm", "md"], validSize],
  ] as const;
  return sections.every(([name, keys, validate]) => {
    const section = value[name];
    return (
      record(section) &&
      exactKeys(section, [...keys]) &&
      Object.values(section).every((v) => typeof v === "string" && validate(v))
    );
  });
}
function validSize(value: string): boolean {
  return (
    value === "0" ||
    (/^(?:\d{1,3})(?:\.\d{1,3})?(?:px|rem)$/.test(value) && Number.parseFloat(value) <= 256)
  );
}

/** Read-only filesystem evidence. `stage` is the host staging directory, NOT a model report. */
export async function collectDesignEvidence(
  stage: string,
  options: DesignEvidenceOptions,
): Promise<DesignEvidence> {
  const report: DesignEvidence = {
    version: 1,
    status: options.required ? "specified" : "not_required",
    artifacts: [],
    issues: [],
    visual: { status: "not_run", reason: "未执行真实浏览器截图视觉检查" },
  };
  if (!options.required) return report;
  let missing = false;
  let invalid = false;
  let total = 0;
  const root = path.resolve(stage);
  const relativeRoot = designSystemPath(options.uiOnly);
  const issue = (message: string, absent = false) => {
    report.issues.push(message);
    if (absent) missing = true;
    else invalid = true;
  };
  const safeDirectory = async (relative: string) => {
    let current = root;
    for (const part of ["", ...relative.split("/").filter(Boolean)]) {
      current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe_directory");
      if ((await fs.realpath(current)) !== current) {
        // Windows may normalize drive letter casing; compare using platform rules only.
        const actual = await fs.realpath(current);
        if (!(process.platform === "win32" && actual.toLowerCase() === current.toLowerCase()))
          throw new Error("unsafe_directory");
      }
    }
  };
  const read = async (relative: string): Promise<string | null> => {
    try {
      if (
        !/^(?:client\/)?design-system\/(?:MASTER\.md|tokens\.json|pages\/[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.md)$/.test(
          relative,
        )
      )
        throw new Error("unsafe_path");
      await safeDirectory(path.posix.dirname(relative));
      const file = path.resolve(root, relative);
      if (!file.startsWith(root + path.sep)) throw new Error("unsafe_path");
      const before = await fs.lstat(file);
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        before.size > DESIGN_EVIDENCE_LIMITS.fileBytes
      )
        throw new Error("unsafe_file");
      const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let data: Buffer;
      try {
        const stat = await handle.stat();
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.dev !== before.dev ||
          stat.ino !== before.ino ||
          stat.size !== before.size
        )
          throw new Error("changed_file");
        const buffer = Buffer.alloc(DESIGN_EVIDENCE_LIMITS.fileBytes + 1);
        let length = 0;
        while (length < buffer.length) {
          const chunk = await handle.read(buffer, length, buffer.length - length, length);
          if (!chunk.bytesRead) break;
          length += chunk.bytesRead;
        }
        const after = await handle.stat();
        const current = await fs.lstat(file);
        if (
          length !== stat.size ||
          length > DESIGN_EVIDENCE_LIMITS.fileBytes ||
          after.nlink !== 1 ||
          current.nlink !== 1 ||
          current.isSymbolicLink() ||
          current.ino !== stat.ino ||
          current.dev !== stat.dev ||
          after.size !== stat.size ||
          after.mtimeMs !== stat.mtimeMs ||
          after.ctimeMs !== stat.ctimeMs
        )
          throw new Error("changed_file");
        data = buffer.subarray(0, length);
      } finally {
        await handle.close();
      }
      total += data.length;
      if (total > DESIGN_EVIDENCE_LIMITS.totalBytes) throw new Error("total_limit");
      const text = data.toString("utf8");
      if (data.includes(0) || !Buffer.from(text).equals(data)) throw new Error("invalid_encoding");
      report.artifacts.push({
        path: relative,
        sha256: createHash("sha256").update(data).digest("hex"),
      });
      return text;
    } catch (error) {
      const absent = (error as NodeJS.ErrnoException).code === "ENOENT";
      issue(
        `${relative}: ${absent ? "缺少规范文件" : "拒绝不安全、超限或读取中变更的规范文件"}`,
        absent,
      );
      return null;
    }
  };
  const master = await read(`${relativeRoot}/MASTER.md`);
  if (master !== null)
    for (const field of MASTER_FIELDS) {
      if (!hasMasterField(master, field)) issue(`MASTER.md: 缺少非空字段“${field}”`);
    }
  const tokens = await read(`${relativeRoot}/tokens.json`);
  if (tokens !== null) {
    try {
      if (!validTokens(JSON.parse(tokens))) issue("tokens.json: 不符合固定 tokens schema");
    } catch {
      issue("tokens.json: 无效 JSON");
    }
  }
  try {
    await safeDirectory(`${relativeRoot}/pages`);
    const directory = await fs.opendir(path.join(root, relativeRoot, "pages"));
    let count = 0;
    try {
      for await (const entry of directory) {
        if (++count > DESIGN_EVIDENCE_LIMITS.pages) {
          issue("pages: 超过32个目录项上限");
          break;
        }
        if (!entry.isFile() || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.md$/.test(entry.name)) {
          issue("pages: 拒绝链接、子目录或不安全的页面文件名");
          continue;
        }
        const page = await read(`${relativeRoot}/pages/${entry.name}`);
        if (page !== null && !page.trim()) issue(`pages/${entry.name}: 页面规范为空`);
      }
    } finally {
      /* for-await closes the directory, including early breaks. */
    }
    if (!count) issue("pages: 至少需要一份页面规范", true);
  } catch (error) {
    issue("pages: 缺少或不安全的页面规范目录", (error as NodeJS.ErrnoException).code === "ENOENT");
  }
  report.artifacts.sort((a, b) => a.path.localeCompare(b.path));
  report.status = invalid ? "invalid" : missing ? "missing" : "specified";
  return report;
}
