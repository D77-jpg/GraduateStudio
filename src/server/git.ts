import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import { resolveProjectDir, safeJoin } from "@/server/workspace/paths";

/**
 * Phase 8:项目本地 Git 版本管理。
 * 只做本地版本控制(init/commit/branch/diff/log/rollback/restore),无远端。
 * 所有 git 调用使用 execFile 参数数组(不走 shell,杜绝注入);
 * 分支名/路径经过校验后拼进参数,不与选项混淆(--end-of-disambiguation / --)。
 */

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  code: string;
  constructor(message: string, code = "git_error") {
    super(message);
    this.name = "GitError";
    this.code = code;
  }
}

export const GIT_TIMEOUT_MS = 60_000;

async function git(projectId: string, args: string[]): Promise<string> {
  const cwd = resolveProjectDir(projectId);
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (e) {
    const err = e as { stderr?: string; message?: string; killed?: boolean };
    if (err.killed) throw new GitError("git 命令超时", "git_timeout");
    throw new GitError(
      `git ${args[0]} 失败:${(err.stderr || err.message || "未知错误").trim().slice(0, 500)}`,
    );
  }
}

const GITIGNORE_CONTENT = [
  "# 依赖与构建产物",
  "node_modules/",
  "dist/",
  "build/",
  ".vite/",
  "coverage/",
  "",
  "# 本地环境与日志",
  ".env",
  ".env.local",
  "*.log",
  "",
  "# 系统文件",
  ".DS_Store",
  "Thumbs.db",
  "",
].join("\n");

/** 校验分支名:仅允许字母数字与 _ . / -,不以 - 或 . 开头(防选项注入)。 */
export function validateBranchName(name: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z][A-Za-z0-9._/-]*$/.test(trimmed) || trimmed.includes("..")) {
    throw new GitError("分支名只能包含字母、数字、_ . /,且以字母开头", "invalid_branch");
  }
  if (trimmed.length > 60) throw new GitError("分支名过长", "invalid_branch");
  return trimmed;
}

/** 确保 .gitignore 存在(缺失才创建,不覆盖用户文件)。 */
function ensureGitignore(projectId: string): void {
  const abs = safeJoin(resolveProjectDir(projectId), ".gitignore");
  if (!fs.existsSync(abs)) {
    fs.writeFileSync(abs, GITIGNORE_CONTENT, "utf8");
  }
}

/** 本地身份缺失时给仓库配置(不污染全局)。git config 读不到键时以退出码 1 结束,属正常情况。 */
async function ensureIdentity(projectId: string): Promise<void> {
  let email = "";
  try {
    email = (await git(projectId, ["config", "user.email"])).trim();
  } catch {
    email = "";
  }
  if (!email) {
    await git(projectId, ["config", "user.email", "agent@graduatestudio.local"]);
    await git(projectId, ["config", "user.name", "GraduateStudio"]);
  }
}

export interface GitRepoStatus {
  initialized: boolean;
  branch: string;
  branches: Array<{ name: string; current: boolean }>;
  hasCommits: boolean;
  changes: Array<{ path: string; status: string }>;
}

/** 读取工作区变更(git status --porcelain 解析)。 */
function parsePorcelain(out: string): Array<{ path: string; status: string }> {
  return out
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter(Boolean)
    .map((line) => {
      const code = line.slice(0, 2).trim();
      const filePath = line.slice(3).trim().replace(/^"|"$/g, "");
      const statusMap: Record<string, string> = {
        A: "added",
        M: "modified",
        D: "deleted",
        "??": "untracked",
        R: "renamed",
        C: "copied",
        U: "conflicted",
      };
      return { path: filePath, status: statusMap[code] ?? (code || "modified") };
    });
}

/**
 * 确保仓库可用:未 init 则初始化;仓库存在但没有任何提交(如上次初始化被中断)时补建基线提交。
 * 返回是否有新提交产生(供日志记录)。
 */
export async function ensureRepo(
  projectId: string,
): Promise<{ created: boolean; initialCommit: boolean }> {
  const dotGit = safeJoin(resolveProjectDir(projectId), ".git");
  let created = false;
  if (!fs.existsSync(dotGit)) {
    await git(projectId, ["init", "-b", "main"]);
    ensureGitignore(projectId);
    created = true;
  }
  await ensureIdentity(projectId);

  // 无任何提交(空仓库)→ 建基线提交(工作区为空时跳过)
  let hasCommits = true;
  try {
    await git(projectId, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    hasCommits = false;
  }
  if (!hasCommits) {
    const status = await git(projectId, ["status", "--porcelain"]);
    if (status.trim()) {
      await git(projectId, ["add", "-A"]);
      await git(projectId, ["commit", "-m", "chore: initial project scaffold", "--no-verify"]);
      return { created, initialCommit: true };
    }
  }
  return { created, initialCommit: false };
}

/** 完整状态:分支、分支列表、工作区变更。 */
export async function getStatus(projectId: string): Promise<GitRepoStatus> {
  const initialized = fs.existsSync(safeJoin(resolveProjectDir(projectId), ".git"));
  if (!initialized) {
    return { initialized: false, branch: "main", branches: [], hasCommits: false, changes: [] };
  }
  let hasCommits = true;
  try {
    await git(projectId, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    hasCommits = false;
  }
  // branch --show-current 对空仓库(unborn HEAD)也返回分支名
  const branch = (await git(projectId, ["branch", "--show-current"])).trim() || "main";
  const branchOut = await git(projectId, ["branch", "--list"]);
  const branches = branchOut
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter(Boolean)
    .map((l) => ({ name: l.replace(/^\*\s*/, "").trim(), current: l.startsWith("*") }));
  const changes = parsePorcelain(await git(projectId, ["status", "--porcelain"]));
  return { initialized: true, branch, branches, hasCommits, changes };
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  body: string;
  author: string;
  date: string;
  files: Array<{ path: string; status: string; additions: number; deletions: number }>;
}

const COMMIT_SEPARATOR = "\u0001GS\u0001";

/** 提交历史(含每个提交的文件与增删行数)。 */
export async function listCommits(projectId: string, limit = 50): Promise<CommitInfo[]> {
  const out = await git(projectId, [
    "log",
    `-n${limit}`,
    "--date=iso-strict",
    `--pretty=format:%H${COMMIT_SEPARATOR}%h${COMMIT_SEPARATOR}%s${COMMIT_SEPARATOR}%b${COMMIT_SEPARATOR}%an${COMMIT_SEPARATOR}%aI`,
    "--numstat",
  ]);
  if (!out.trim()) return [];

  const commits: CommitInfo[] = [];
  const blocks = out.split(/(?=^[0-9a-f]{40}\u0001GS\u0001)/m);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.length > 0);
    const head = lines.shift();
    if (!head) continue;
    const [hash, shortHash, message, body, author, date] = head.split(COMMIT_SEPARATOR);
    const files = lines
      .map((l) => l.split("\t"))
      .filter((parts) => parts.length >= 3)
      .map((parts) => ({
        path: parts[2],
        status: "modified",
        additions: parts[0] === "-" ? 0 : Number(parts[0]),
        deletions: parts[1] === "-" ? 0 : Number(parts[1]),
      }));
    commits.push({
      hash,
      shortHash,
      message: (message ?? "").trim(),
      body: (body ?? "").trim(),
      author: author ?? "",
      date: date ?? "",
      files,
    });
  }
  return commits;
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  patch: string;
  additions: number;
  deletions: number;
}

/** 统一 diff 解析为按文件的 patch(+/- 行数与 patch 文本)。 */
function parseUnifiedDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  const chunks = diffText.split(/^diff --git /m).filter((c) => c.trim());
  for (const chunk of chunks) {
    const headerMatch = chunk.match(/^a\/(.+?) b\/(.+)$/m);
    if (!headerMatch) continue;
    const lines = chunk.split("\n");
    const patchStart = lines.findIndex((l) => l.startsWith("@@"));
    const patch = patchStart >= 0 ? lines.slice(patchStart).join("\n") : "";
    let additions = 0;
    let deletions = 0;
    for (const line of lines.slice(patchStart >= 0 ? patchStart : 0)) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
    const oldPath = headerMatch[1] !== headerMatch[2] ? headerMatch[1] : undefined;
    files.push({ path: headerMatch[2], oldPath, patch, additions, deletions });
  }
  return files;
}

/** Diff:hash 传 "HEAD" 或具体提交;working=true 时对比工作区与 HEAD。 */
export async function getDiff(projectId: string, hash?: string): Promise<DiffFile[]> {
  await ensureRepo(projectId);
  const target = hash?.trim() || "HEAD";
  if (target === "WORKING") {
    const out = await git(projectId, ["diff", "HEAD", "--no-color"]);
    const untracked = await git(projectId, ["ls-files", "--others", "--exclude-standard"]);
    const files = parseUnifiedDiff(out);
    for (const line of untracked.split("\n").filter(Boolean)) {
      files.push({ path: line.trim(), patch: "(新文件,尚未提交)", additions: 0, deletions: 0 });
    }
    return files;
  }
  if (!/^[0-9a-f]{7,40}$/.test(target) && target !== "HEAD") {
    throw new GitError("非法的提交 hash", "invalid_hash");
  }
  const out = await git(projectId, ["show", target, "--no-color", "--format="]);
  return parseUnifiedDiff(out);
}

/** 提交全部变更。 */
export async function commitAll(
  projectId: string,
  message: string,
): Promise<{ hash: string; shortHash: string; files: number }> {
  await ensureRepo(projectId);
  const status = await git(projectId, ["status", "--porcelain"]);
  if (!status.trim()) throw new GitError("没有可提交的变更,工作区是干净的", "nothing_to_commit");
  await git(projectId, ["add", "-A"]);
  await execFileAsync("git", ["commit", "-m", message, "--no-verify"], {
    cwd: resolveProjectDir(projectId),
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  const hash = (await git(projectId, ["rev-parse", "HEAD"])).trim();
  const fileCount = status.split("\n").filter(Boolean).length;
  return { hash, shortHash: hash.slice(0, 7), files: fileCount };
}

/** 创建并切换分支(基于当前 HEAD)。 */
export async function createBranch(projectId: string, name: string): Promise<{ branch: string }> {
  await ensureRepo(projectId);
  const safe = validateBranchName(name);
  await git(projectId, ["checkout", "-b", safe]);
  return { branch: safe };
}

/** 切换分支(不携带未提交变更时由 git 决定,拒绝则抛错)。 */
export async function checkoutBranch(projectId: string, name: string): Promise<{ branch: string }> {
  await ensureRepo(projectId);
  const safe = validateBranchName(name);
  await git(projectId, ["checkout", safe]);
  return { branch: safe };
}

export interface RollbackResult {
  backupBranch: string;
  restoredTo: string;
  shortHash: string;
}

/**
 * 回滚到指定提交:先建备份分支保留当前进度,再 reset --hard。
 * 丢在工作区的未提交变更也会被清掉(备份分支不含未提交内容,属预期行为)。
 */
export async function rollbackToCommit(projectId: string, hash: string): Promise<RollbackResult> {
  await ensureRepo(projectId);
  const target = hash.trim();
  if (!/^[0-9a-f]{7,40}$/.test(target)) throw new GitError("非法的提交 hash", "invalid_hash");
  // 校验提交存在
  const full = (await git(projectId, ["rev-parse", "--verify", `${target}^{commit}`])).trim();
  const current = (await git(projectId, ["rev-parse", "HEAD"])).trim();
  if (full === current) throw new GitError("已经在这个版本上,无需回滚", "already_at_commit");
  const backupBranch = `backup/pre-rollback-${Date.now()}`;
  await git(projectId, ["branch", validateBranchName(backupBranch), "HEAD"]);
  await git(projectId, ["reset", "--hard", full]);
  return { backupBranch, restoredTo: full, shortHash: full.slice(0, 7) };
}

/** 从指定提交恢复单个文件到工作区与暂存区。 */
export async function restoreFileFromCommit(
  projectId: string,
  hash: string,
  filePath: string,
): Promise<{ path: string }> {
  await ensureRepo(projectId);
  const target = hash.trim();
  if (!/^[0-9a-f]{7,40}$/.test(target) && target !== "HEAD") {
    throw new GitError("非法的提交 hash", "invalid_hash");
  }
  const clean = filePath.trim().replaceAll("\\", "/");
  if (clean.includes("..")) throw new GitError("非法文件路径", "invalid_path");
  await git(projectId, ["checkout", target, "--", clean]);
  return { path: clean };
}
