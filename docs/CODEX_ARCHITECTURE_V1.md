# Codex development execution architecture — staged migration

## Scope and current status

Local and full development dispatch Codex before legacy full mode when `GRADUATESTUDIO_AGENT_ENGINE=codex`. Requirements/architecture/chat/papers remain outside this migration. Full development uses native Codex to create a versioned module DAG, verifies exact saved feature coverage, then invokes native Codex for dependency-ordered module work. Independent failed engineering checks trigger at most two native Codex repair rounds; blocked checks never trigger blind retries; repeated evidence or no file change stops repairs. Remaining failed/blocked evidence stays visible in proposal summary and cannot become acceptance success. A module checkpoint means generation ended, not acceptance passed. No silent provider fallback in this native task path. Legacy runner retained for explicitly selected legacy mode and old legacy checkpoints.

This is **not production completion**. Offline dependency provisioning, a controlled dependency-download path, and independent engineering checks (Node build/test plus Python wheel/venv/pytest) are connected and verified against real Docker. Full business acceptance is not implemented and cannot be inferred from engineering checks. Tasks stop at pending review. Accepted files project as `applied_unverified`; post-apply verification runs in an isolated copy and never rewrites the applied project. No real paid full-project run is authorized or performed.

## Trust boundary

`codex-container.ts` requires an already-built Linux image `gs-codex-worker:0.150.1`, pins its inspected image ID, and never falls back to a host CLI. Worker is non-root, read-only rootfs, limited CPU/memory/PIDs, no network, no Docker socket. Only durable disposable stage is writable host bind. Generated non-secret config is read-only. Worker reaches localhost HTTP shim -> dedicated Unix socket Docker volume -> separate gateway. Gateway injects real key and can POST only to fixed HTTPS `/responses`, rejects private IPv4 DNS destinations and redirects. Personal Codex MCP/config is not inherited.

Gateway Docker administrator can inspect secret environment; privileged host/Docker compromise and shared-kernel exploits are out of scope. Worker can consume API quota or exfiltrate stage content through permitted model calls; API gateway is a narrow egress channel, not information-flow proof. No untrusted multi-tenant daemon exposure is claimed.

Credentials: prefer server-only GS_CODEX_API_KEY; GS_CODEX_MODEL defaults deepseek-flash, GS_CODEX_BASE_URL defaults https://api.deepseek.com. Temporary compatibility extraction of one literal bearer from user Codex config is available; it never copies auth/config into worker or exposes token to user output. Replace with a managed secret store for deployment.

## Workspace and audit

Durable host-owned checkpoint/journal lives under GRADUATESTUDIO_STATE_ROOT (default .agent-state), outside model-mounted stage and project workspace. Snapshot text baseline is immutable; SHA256 inventory detects concurrent original edits and binary changes. Binary resources copied to stage, but binary modifications cannot enter text ChangeSets. Secret/data files, node_modules, Git and build outputs explicitly excluded. Symlinks fail closed. Limits: source inventory 8MB/file,64MB total,10000 files; text audit 2MB/file,32MB total. An unsupported project is blocked, never described as completely copied.

No borrowing host dependencies, no unrestricted registry network. Dependency provisioning has two modes. With a trusted offline cache (`GS_CODEX_NPM_CACHE`) it stays fully offline and requires a strict lockfile v2/v3. Without one, it uses a temporary `--internal` Docker network whose only egress member is a proxy restricted to `CONNECT` on 443 for `registry.npmjs.org`, `pypi.org` and `files.pythonhosted.org`, with public-IPv4 validation, end-to-end TLS and no credential injection; the installer/downloader container itself has no default route. A missing lockfile is generated **inside the disposable copy only** (reported as `lockfileGenerated`) and the real project is never rewritten. Unsafe manifests are still blocked. See CODEX_DEPENDENCIES.md. Independent build/test commands execute only in another network-disabled container; absent scripts/dependencies or zero/fully skipped tests cannot become passed. Node checks run the declared build/test scripts; Python roots additionally get wheel download through the same proxy, an offline venv install, `compileall` and a real `pytest` run reported from its JUnit evidence. No business readiness claim follows from these engineering checks.

Scope: local default project scope; explicit `[scope:client]` prefix enforces client-only proposal scope. UI keyword regex no longer constrains full tasks. Full requirement fingerprint change blocks resume. Host stage bookkeeping `.gs-codex` is excluded from proposal changes, not claimed to be business deliverable.

## Lifecycle and recovery

Pause -> abort -> await CLI/container stop -> retain stage/checkpoint -> paused. Resume creates fresh controller and invocation at retained workspace, not native model-thread continuation (`--ephemeral`). Cancel is terminal; evidence remains. Reaper preserves recoverable checkpoint and review state. Single-machine project file lease refuses a live owning PID, stale lease is recovered only after process death; exact stage Docker labels scope orphan cleanup. Worker/gateway hard lifetimes bound execution after app death. This is NOT a multi-host distributed lock; PID reuse or damaged lease requires manual intervention.

Checkpoint identity/schema/path/symlinks validated; writes serialized and atomic rename. Module plan and completed-module journal are outside worker's mount. Interrupted module may run again against partially edited stage; original immutable baseline remains unchanged. Legacy FULL_PROJECT_CHECKPOINT stays legacy; no automatic conversion into Codex checkpoint.

Failure/cancel/pause stage retained indefinitely by default to avoid lost work. Operator retention policy: inspect checkpoint and pending ChangeSet first; only remove terminal/rejected state after backup and explicit user approval. No automatic evidence deletion job yet; monitor disk use.

Review publication uses deterministic task title, stored pending ID, immutable expected baselines. User accepts/rejects via existing changesets UI. Acceptance checks all baseline paths before writes and compensates same-process write/DB failure. Per-project process mutex serializes accept/reject only; external editors and multiple app processes are not locked. Filesystem+SQLite crash atomicity remains a known gap; backup required. Never auto-accept generated changes.

## Protocol and UI

Pinned CLI 0.150.1. Strict bounded JSONL and UTF8 parsing; terminal turn.completed required; reasoning ignored; tools allowlisted/redacted and bounded. Wait for child close and container cleanup before final snapshot. Raw secret-bearing stderr not persisted; actionable classified failures shown. Actual diff counts separate staged/applied, model/last scan shown, no invented file progress.

## Deployment and rollback

1. Run one app process (current concurrency limitation), persistent DB/project/state volumes.
2. Build `docker build -t gs-codex-worker:0.150.1 docker/codex-worker`. Never mount daemon socket in worker. Web currently controls local Docker; production split trusted worker service is not completed.
3. Configure server secrets, official provider URL/model, engine and state root. Docker daemon must see stage host path (remote daemon requires explicit volume architecture, not supported).
4. Build isolated release using GRADUATESTUDIO_NEXT_DIST_DIR=.next-codex-v2 then start with same variable. Do not overwrite live .next. Confirm no active tasks before swapping 4311 service.
5. Validate authenticated task GET/control, API health, preview URLs and owned Docker resource cleanup.
6. Rollback: stop new instance after tasks settle, start prior artifact and explicit legacy engine if desired. Do not resume a Codex checkpoint using legacy; preserve state/backups. Existing 3000 service must never be stopped/reused.

## Verification record (in progress)

- Full tests final:67 passed files +1 opt-in integration file skipped;872 passed,5 skipped (4 opt-in DB cases +1 Windows platform skip). Native orchestration34 tests cover bounded Codex repairs; control11 tests cover ending unverified review.
- TypeScript and independent production build pass.
- Build warnings: middleware convention deprecated;12 dynamic filesystem tracing warnings in final release (including new runtime state/provision/check modules); not resolved by pretending runtime files are build assets.
- Real Docker build/version/nonroot/network-none/broker allowlist/create/dispose smokes pass.
- Real official deepseek-flash fixture PASSED via isolated worker: read Chinese file, edit exact UTF8 content plus newline, actual single-file diff, terminal completion and cleanup. Local DNS fake-IP 198.18/15 was correctly denied; fixture used explicit public GS_CODEX_UPSTREAM_IP pin with unchanged HTTPS hostname/certificate validation. No runtime DNS safety bypass. Pin must be operator-maintained when provider address changes.
- Real disposable SQLite ChangeSet integration PASSED (4 cases): pending no write, accepted exact UTF8, original manual conflict denied, stale expected baseline denied, real ownership/project guards; test DB removed.
- Real no-dependency independent Docker check fixture PASSED build syntax check plus one Node test with actual TAP result/Chinese output.
- Existing URL safely updated after ACTIVE_TASKS=0: platform4311 health/login200, authenticated task GET14 rows running=false, authenticated agent page200; preview4407 activity API200 and backend8181 health200.3000 not touched.
- Full paid end-to-end generation, actual trusted-cache dependency installation, broad business acceptance, remote/distributed worker recovery NOT verified.
- Applied-unverified tasks can explicitly be ended/cancelled without undoing files or asserting acceptance, so review does not permanently occupy project task slot.
- Old JSON implementation adapter entry now rejects Codex selection instead of spawning a host CLI. Legacy checkpoint resume under Codex setting is explicitly rejected; select Legacy to resume Legacy state.
