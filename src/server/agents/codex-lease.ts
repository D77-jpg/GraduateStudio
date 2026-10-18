import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Local-machine process lease, not a distributed lease. Never steals a live PID. */
export async function acquireCodexProjectLease(stage: string): Promise<() => Promise<void>> {
  const directory = path.dirname(path.dirname(path.dirname(stage)));
  const file = path.join(directory, ".codex-project-lease.json");
  const token = randomUUID();
  const value = { pid: process.pid, token, stage, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fs.writeFile(file, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      return async () => {
        const current = JSON.parse(await fs.readFile(file, "utf8"));
        if (current.token !== token)
          throw new Error("Codex 项目执行租约已改变，拒绝释放其他任务租约");
        await fs.unlink(file);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await fs.lstat(file)).isSymbolicLink()) throw new Error("执行租约不允许符号链接");
      const current = JSON.parse(await fs.readFile(file, "utf8"));
      if (
        !Number.isSafeInteger(current.pid) ||
        current.pid <= 0 ||
        typeof current.token !== "string"
      )
        throw new Error("执行租约损坏，需人工核验后恢复");
      try {
        process.kill(current.pid, 0);
        throw new Error("项目已有活动 Codex 执行进程，请等待其停止");
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
      }
      // Exclusive claim of stale file. Re-read and never unlink replacement lease.
      const stale = file + ".stale-" + current.token;
      await fs.rename(file, stale);
      const moved = JSON.parse(await fs.readFile(stale, "utf8"));
      if (moved.token !== current.token) throw new Error("执行租约竞争，请人工检查");
      await fs.rm(stale);
    }
  }
  throw new Error("无法获得项目执行租约");
}
