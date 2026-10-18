import { createIsolatedCodexEngine } from "../../src/server/agents/codex-container";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
function docker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("docker", args, { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (c) => (c === 0 ? resolve(out) : reject(Error("diagnostic failed"))));
  });
}
void (async () => {
  process.env.GS_CODEX_API_KEY = "invalid-transport-smoke-key";
  const dir = await mkdtemp(path.join(tmpdir(), "gs-transport-"));
  const before = (await docker(["ps", "--format", "{{.Names}}"])).split("\n");
  const x = await createIsolatedCodexEngine(dir);
  try {
    const gateway = (await docker(["ps", "--format", "{{.Names}}"]))
      .split("\n")
      .find((n) => n.endsWith("-gateway") && !before.includes(n));
    if (!gateway) throw Error("missing gateway");
    console.log(
      (
        await docker([
          "exec",
          gateway,
          "node",
          "--input-type=module",
          "-e",
          "import http from 'node:http';const q=http.request({socketPath:'/broker/api.sock',path:'/responses',method:'POST',headers:{'content-type':'application/json'}},r=>{console.log('BROKER_STATUS',r.statusCode);r.on('data',d=>console.log('BROKER_SAFE_BODY',d.toString()))});q.on('error',e=>console.log('SOCKET_ERROR',e.code));q.end('{}');",
        ])
      ).trim(),
    );
  } finally {
    await x.dispose();
    await rm(dir, { recursive: true, force: true });
  }
})();
