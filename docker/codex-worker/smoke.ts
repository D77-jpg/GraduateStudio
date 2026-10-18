// Explicit opt-in, no paid API requests: pnpm exec tsx docker/codex-worker/smoke.ts
import { createIsolatedCodexEngine } from "../../src/server/agents/codex-container";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function docker(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("docker", args, { stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error("Docker smoke failed")),
    );
  });
}
async function main() {
  // Do not use a real key, even if the operator has one configured.
  process.env.GS_CODEX_API_KEY = "smoke-placeholder-not-a-real-key";
  const stage = await mkdtemp(path.join(tmpdir(), "gs-codex-smoke-"));
  try {
    const isolated = await createIsolatedCodexEngine(stage);
    try {
      console.log(JSON.stringify(isolated.metadata));
      await docker([
        "run",
        "--rm",
        "--pull",
        "never",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--entrypoint",
        "node",
        "gs-codex-worker:0.150.1",
        "--input-type=module",
        "-e",
        "import fs from 'node:fs';import os from 'node:os';import{execFileSync}from'node:child_process';if(Object.keys(os.networkInterfaces()).some(n=>n!=='lo'))process.exit(1);console.log(execFileSync('codex',['--version'],{encoding:'utf8'}).trim());if(fs.existsSync('/var/run/docker.sock'))process.exit(1);if(process.getuid()===0)process.exit(1);console.log('NETWORK_NONE_NONROOT_NATIVE_OK');",
      ]);
      await docker([
        "run",
        "--rm",
        "--pull",
        "never",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--tmpfs",
        "/broker:rw,nosuid,nodev,mode=1777",
        "--entrypoint",
        "node",
        "gs-codex-worker:0.150.1",
        "--input-type=module",
        "-e",
        "import http from 'node:http';import fs from 'node:fs';import{spawn}from'node:child_process';const g=spawn('node',['/opt/gs/gateway.mjs'],{env:{...process.env,GS_UPSTREAM:'https://api.deepseek.com',GS_BROKER_KEY:'fake'},stdio:'inherit'});try{for(let i=0;i<100&&!fs.existsSync('/broker/api.sock');i++)await new Promise(r=>setTimeout(r,20));for(const [method,path]of[['GET','/responses'],['POST','/models'],['POST','http://192.168.1.1/responses'],['POST','/responses?url=http://localhost']]){const status=await new Promise((resolve,reject)=>{const q=http.request({socketPath:'/broker/api.sock',method,path,headers:{'content-type':'application/json'}},r=>{r.resume();resolve(r.statusCode)});q.on('error',reject);q.end()});if(status!==403)throw Error('Allowlist bypass');}console.log('BROKER_ALLOWLIST_OK');}finally{g.kill();}",
      ]);
      console.log("CREATE_OK");
    } finally {
      await isolated.dispose();
    }
    console.log("DISPOSE_OK");
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
void main().catch(() => {
  console.error("Isolated Codex smoke failed (no credentials logged).");
  process.exitCode = 1;
});
