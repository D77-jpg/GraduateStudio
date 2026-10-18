// Run only in a --network none container with /tmp tmpfs. No API traffic is possible.
import fs from "node:fs";
import { spawn } from "node:child_process";
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
fs.writeFileSync(
  `${process.env.CODEX_HOME}/config.toml`,
  'model="deepseek-flash"\nmodel_provider="gs_broker"\n[model_providers.gs_broker]\nname="broker"\nbase_url="http://127.0.0.1:8080"\nwire_api="responses"\nenv_key="GS_WORKER_TOKEN"\nrequires_openai_auth=false\n',
);
const args = [
  "--ask-for-approval",
  "never",
  "-c",
  "features.js_repl=false",
  "exec",
  "--json",
  "--ephemeral",
  "--skip-git-repo-check",
  "--sandbox",
  "danger-full-access",
  "--cd",
  "/workspace",
  "No action. Reply OK.",
];
if (process.env.GS_SMOKE_INVALID_MCP === "1")
  args.unshift("-c", "mcp_servers.cnki-search.enabled=false");
const child = spawn("codex", args, {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, GS_WORKER_TOKEN: "not-real" },
});
let started = false;
child.stdout.on("data", (data) => {
  process.stdout.write(data);
  if (data.toString().includes("thread.started")) started = true;
});
child.stderr.pipe(process.stderr);
const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
child.on("exit", () => {
  clearTimeout(timer);
  process.exit(started ? 0 : 1);
});
