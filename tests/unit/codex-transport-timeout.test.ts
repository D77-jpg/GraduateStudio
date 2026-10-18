import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
describe("Codex upstream timeout policy", () => {
  it("reproduces silent socket timeout and accepts delayed response with bounded longer budget", () => {
    const out = execFileSync(process.execPath, ["docker/codex-worker/timeout-smoke.mjs"], {
      encoding: "utf8",
      timeout: 10000,
    });
    expect(out).toContain("SCALED_REAL_SOCKET_TIMEOUT_REPRODUCED_AND_FIXED");
    expect(out).toContain("600000");
  });
  it("does not append plaintext into an already started SSE response", () => {
    const gateway = readFileSync("docker/codex-worker/gateway.mjs", "utf8");
    expect(gateway).toContain("if (res.headersSent) res.destroy()");
    expect(gateway).toContain("UPSTREAM_STREAM_ABORTED");
    expect(gateway).toContain("/broker/transport-status");
    expect(gateway).not.toContain("upstream.setTimeout(120000");
  });
});
