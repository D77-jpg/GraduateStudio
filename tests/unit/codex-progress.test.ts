import { describe, it, expect } from "vitest";
import { describeCodexTool, parseCodexProgress, CODEX_PROGRESS_PREFIX } from "@/lib/codex-progress";
describe("Codex progress display", () => {
  it("shows commands and actual exit codes without credentials", () => {
    const d = describeCodexTool(
      {
        type: "command_execution",
        command: "npm run build",
        exit_code: 1,
        aggregated_output: "sk-secret",
      },
      false,
    );
    expect(d.message).toContain("执行失败");
    expect(d.message).toContain("检查项目构建");
    expect(d.detail).toContain("npm run build");
    expect(d.detail).toContain("退出码：1");
    expect(d.detail).not.toContain("sk-secret");
  });
  it("distinguishes staged paths from applied changes", () => {
    expect(
      parseCodexProgress(
        CODEX_PROGRESS_PREFIX + JSON.stringify({ files: ["client/a.vue"], latest: "building" }),
      )?.files,
    ).toEqual(["client/a.vue"]);
    expect(parseCodexProgress("ordinary detail")).toBeNull();
    expect(parseCodexProgress(CODEX_PROGRESS_PREFIX + "{}")).toBeNull();
  });
});
