import { z } from "zod";
import { dependencyDocker } from "../agents/codex-dependency-network";
import { assertPythonResourceLabels, pythonStackIdentity } from "./python-stack";

const states = [
  "queued",
  "running",
  "retrying",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
  "missing",
] as const;
const failures = [
  "MODEL_TIMEOUT",
  "MODEL_CONNECT_ERROR",
  "MODEL_RATE_LIMITED",
  "MODEL_SERVER_ERROR",
  "MODEL_AUTH_FAILED",
  "MODEL_BAD_REQUEST",
  "MODEL_RESPONSE_INVALID",
  "MODEL_EMPTY_RESPONSE",
  "MODEL_CONFIG_INVALID",
  "TASK_EXECUTION_TIMEOUT",
  "TASK_DISPATCH_FAILED",
  "UNKNOWN",
] as const;
const connectivity = [
  "connected",
  "refused",
  "timeout",
  "dns_error",
  "blocked",
  "not_configured",
] as const;
const modelPorts = [80, 443, 3000, 5000, 7863, 8000, 8080, 8081, 8888, 9000, 11434];
const INSPECT_FORMAT =
  '{"Id":{{json .Id}},"Name":{{json .Name}},"Config":{"Labels":{{json .Config.Labels}},"User":{{json .Config.User}}},"State":{"Running":{{json .State.Running}},"Paused":{{json .State.Paused}},"Restarting":{{json .State.Restarting}}}}';
const endpointSchema = z
  .object({
    serviceId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    port: z.number().int().min(1).max(65535).nullable(),
    hostKind: z.enum(["loopback", "private", "public", "local_name"]).nullable(),
  })
  .strip();
const observationSchema = z
  .object({
    taskId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    taskState: z.enum(states),
    failureCode: z.enum(failures).nullable(),
    endpoint: endpointSchema,
    connectivity: z.enum(connectivity),
    result: z.enum(["ok", "missing", "unsupported", "blocked"]),
  })
  .strip();

export interface RuntimeRepairEvidenceReport {
  version: 1;
  status: "collected" | "blocked";
  taskId: number | null;
  taskState: (typeof states)[number];
  failureCode: (typeof failures)[number] | null;
  failureSummary: string | null;
  endpoint: z.infer<typeof endpointSchema>;
  connectivity: (typeof connectivity)[number];
  modelCalls: 0;
  needsUserAction: boolean;
  issues: string[];
}

const notes = {
  source:
    "Runtime observations originate from existing project code and are not independent trusted verification.",
  diagnostic:
    "Diagnostics only: no model generation, authentication, business retry or repair was performed.",
  loopback: "Loopback refers to the backend container itself, not the host computer.",
  ambiguous: "Task identity is ambiguous or unsafe; provide exactly one positive numeric task ID.",
  inspect:
    "Owned running Python backend could not be verified; no diagnostic command was executed.",
  output: "Runtime diagnostic output was unavailable or failed the safe output contract.",
  changed:
    "Runtime backend identity or state changed during diagnostics; observations were discarded.",
  missing: "The requested task does not exist in the running project database.",
  unsupported: "The running project does not expose the supported diagnostic database layout.",
  blocked: "The configured endpoint is not permitted for this diagnostic probe.",
  connection: "The configured model endpoint requires user attention; no model request was made.",
} as const;

function blocked(taskId: number | null, issue: string): RuntimeRepairEvidenceReport {
  return {
    version: 1,
    status: "blocked",
    taskId,
    taskState: "unknown",
    failureCode: null,
    failureSummary: null,
    endpoint: { serviceId: null, port: null, hostKind: null },
    connectivity: "blocked",
    modelCalls: 0,
    needsUserAction: true,
    issues: [issue, notes.diagnostic],
  };
}

/** Pure parser: untrusted output is never a command, URL, free-form error or log. */
export function parseRuntimeRepairObservation(
  output: string,
  taskId: number,
): RuntimeRepairEvidenceReport | null {
  if (Buffer.byteLength(output, "utf8") > 8192 || !/^\{[^\r\n]*\}\n?$/.test(output)) return null;
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return null;
  }
  const parsed = observationSchema.safeParse(value);
  if (!parsed.success || parsed.data.taskId !== taskId) return null;
  const data = parsed.data;
  if (data.endpoint.port !== null && !modelPorts.includes(data.endpoint.port)) return null;
  if (
    data.connectivity !== "not_configured" &&
    data.result === "ok" &&
    (data.endpoint.serviceId === null ||
      data.endpoint.port === null ||
      data.endpoint.hostKind === null)
  )
    return null;
  // Even enum values are observations, not proof. Never copy arbitrary summaries from the container.
  const failureSummary =
    data.failureCode === null
      ? null
      : data.failureCode === "MODEL_CONNECT_ERROR"
        ? "The task recorded a model connection failure."
        : data.failureCode === "MODEL_TIMEOUT" || data.failureCode === "TASK_EXECUTION_TIMEOUT"
          ? "The task recorded a timeout."
          : "The task recorded a known failure category.";
  const issues: string[] = [notes.source, notes.diagnostic];
  if (data.endpoint.hostKind === "loopback") issues.push(notes.loopback);
  if (data.result !== "ok") issues.push(notes[data.result]);
  const needsUserAction =
    data.result !== "ok" || data.connectivity !== "connected" || data.taskState === "failed";
  if (needsUserAction && data.result === "ok") issues.push(notes.connection);
  return {
    version: 1,
    status: data.result === "ok" ? "collected" : "blocked",
    taskId,
    taskState: data.taskState,
    failureCode: data.failureCode,
    failureSummary,
    endpoint: data.endpoint,
    connectivity: data.connectivity,
    modelCalls: 0,
    needsUserAction,
    issues,
  };
}

// Fixed source, not derived from the prompt. Existing app imports are untrusted diagnostic
// sources and already run with the backend's business environment; no new mounts/privileges.
const SCRIPT = String.raw`
import sys, os, json, signal, socket, ipaddress, contextlib
from urllib.parse import urlsplit
class BudgetExceeded(BaseException): pass
def expired(*args): raise BudgetExceeded()
signal.signal(signal.SIGALRM, expired)
signal.alarm(15)
task_id=int(sys.argv[1])
r={'taskId':task_id,'taskState':'unknown','failureCode':None,'endpoint':{'serviceId':None,'port':None,'hostKind':None},'connectivity':'blocked','result':'unsupported'}
states=${JSON.stringify(states)}
failures=${JSON.stringify(failures)}
def address(value):
 a=ipaddress.ip_address(value)
 if getattr(a,'ipv4_mapped',None): a=a.ipv4_mapped
 if a.is_loopback: return 'loopback'
 if a.is_link_local or a.is_unspecified or a.is_multicast or a.is_reserved:
  raise ValueError()
 if a.version==4 and (str(a) in ('168.63.129.16','100.100.100.200') or a in ipaddress.ip_network('100.64.0.0/10')):
  raise ValueError()
 if a.is_loopback: return 'loopback'
 if a.is_private: return 'private'
 if not a.is_global: raise ValueError()
 return 'public'
def collect():
 from sqlalchemy import select
 from app.db.session import get_session_factory
 from app.db.models.task import GenerationTask
 from app.db.models.config import ModelServiceConfig
 with get_session_factory()() as db:
  task=db.execute(select(GenerationTask.id,GenerationTask.status,GenerationTask.error_code,GenerationTask.model_service_id).where(GenerationTask.id==task_id)).first()
  if task is None:
   r.update(result='missing',taskState='missing',connectivity='not_configured'); return
  state=getattr(task[1],'value',task[1])
  r['taskState']=state if state in states else 'unknown'
  r['failureCode']=task[2] if task[2] in failures else ('UNKNOWN' if task[2] else None)
  if task[3] is None:
   r.update(result='ok',connectivity='not_configured'); return
  config=db.execute(select(ModelServiceConfig.id,ModelServiceConfig.base_url).where(ModelServiceConfig.id==task[3])).first()
  if config is None:
   r.update(result='ok',connectivity='not_configured'); return
  if type(config[0]) is not int or not 0<config[0]<=9007199254740991: return
  r['endpoint']['serviceId']=config[0]
  raw=config[1]
 r['result']='blocked'
 if not isinstance(raw,str) or len(raw)>2048 or any(ord(c)<33 for c in raw): return
 u=urlsplit(raw)
 if u.scheme not in ('http','https') or u.username is not None or u.password is not None or not u.hostname or '%' in u.hostname: return
 host=u.hostname.lower().rstrip('.')
 if os.environ.get('MODEL_ENDPOINT_HOST_ALIAS')=='host.docker.internal':
  try: local=ipaddress.ip_address(host).is_loopback
  except ValueError: local=host=='localhost'
  if local: host='host.docker.internal'
 if host in ('metadata.google.internal','metadata','instance-data','instance-data.ec2.internal') or host.endswith('.metadata.google.internal'): return
 port=u.port or (443 if u.scheme=='https' else 80)
 # Deliberately narrow model-service port allowlist; no DB, cache, SSH or mail probes.
 if port not in (80,443,3000,5000,7863,8000,8080,8081,8888,9000,11434): return
 r['endpoint']['port']=port
 try:
  infos=socket.getaddrinfo(host,port,type=socket.SOCK_STREAM)
 except socket.gaierror:
  r.update(result='ok',connectivity='dns_error')
  r['endpoint']['hostKind']='local_name'; return
 if not infos or len(infos)>32: return
 # Validate ALL answers, then pin one numeric address. Never reconnect by DNS name.
 kinds=[address(info[4][0]) for info in infos]
 numeric=infos[0][4][0]
 try: ipaddress.ip_address(host); literal=True
 except ValueError: literal=False
 r['endpoint']['hostKind']=kinds[0] if literal or kinds[0]=='loopback' else 'local_name'
 r['result']='ok'
 try:
  with socket.create_connection((numeric,port),timeout=3): pass
  r['connectivity']='connected'
 except ConnectionRefusedError: r['connectivity']='refused'
 except (TimeoutError,socket.timeout): r['connectivity']='timeout'
 except OSError: r['connectivity']='blocked'; r['result']='blocked'
try:
 # Suppress project import/query output; host still rejects any noisy/malformed JSON.
 with open(os.devnull,'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink): collect()
except BudgetExceeded:
 r['result']='blocked'; r['connectivity']='timeout'
except Exception:
 pass
signal.alarm(0)
print(json.dumps(r,separators=(',',':')))
`;

/** Only explicit local/runtime connection failures with one task identity are eligible. */
export async function collectRuntimeRepairEvidence(
  projectId: string,
  message: string,
  signal?: AbortSignal,
): Promise<RuntimeRepairEvidenceReport | null> {
  signal?.throwIfAborted();
  // Caller gates this collector to local worker mode; wording need not mention localhost.
  if (
    !/(?:fail|error|refused|timeout|repair|diagnos|失败|错误|断网|超时|无法连接|连不上|修复|排查)/i.test(
      message,
    )
  )
    return null;
  const matches = [...message.matchAll(/(?:任务|\btask\b)\s*#?\s*([^\s,，。；：]+)/gi)];
  if (!matches.length || !matches.some((match) => /[0-9]/.test(match[1]))) return null;
  const hashReferences = [...message.matchAll(/#\s*([^\s,，。；：]+)/g)];
  const ids = [...matches, ...hashReferences].map(
    (match) => /^(?:[1-9][0-9]{0,14})(?=$|[^\x00-\x7f])/.exec(match[1])?.[0],
  );
  if (
    message.length > 32768 ||
    ids.some((id) => !id || !Number.isSafeInteger(Number(id))) ||
    new Set(ids).size !== 1
  )
    return blocked(null, notes.ambiguous);
  const taskId = Number(ids[0]);
  const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]);
  let stage: "inspect" | "output" | "changed" = "inspect";
  try {
    const identity = pythonStackIdentity(projectId);
    const inspectOwned = async () => {
      const raw = await dependencyDocker(
        ["container", "inspect", identity.container("backend"), "--format", INSPECT_FORMAT],
        combined,
        4_000,
      );
      combined.throwIfAborted();
      if (Buffer.byteLength(raw, "utf8") > 65536) throw new Error("Inspection budget");
      const info = z
        .object({
          Id: z.string().regex(/^[a-f0-9]{64}$/),
          Name: z.literal(`/${identity.container("backend")}`),
          Config: z.object({
            Labels: z.record(z.string(), z.string()),
            User: z.enum(["10001:10001", "10001"]),
          }),
          State: z.object({
            Running: z.literal(true),
            Paused: z.literal(false).optional(),
            Restarting: z.literal(false).optional(),
          }),
        })
        .parse(JSON.parse(raw));
      assertPythonResourceLabels(info.Config.Labels, projectId, "backend");
      return info;
    };
    const info = await inspectOwned();
    stage = "output";
    const output = await dependencyDocker(
      [
        "exec",
        "--workdir",
        "/source",
        info.Id,
        "/tmp/venv/bin/python",
        "-B",
        "-c",
        SCRIPT,
        String(taskId),
      ],
      combined,
      15_000,
    );
    combined.throwIfAborted();
    stage = "changed";
    const after = await inspectOwned();
    if (after.Id !== info.Id || after.Config.User !== info.Config.User)
      return blocked(taskId, notes.changed);
    return parseRuntimeRepairObservation(output, taskId) ?? blocked(taskId, notes.output);
  } catch {
    signal?.throwIfAborted();
    return blocked(taskId, notes[stage]);
  }
}
