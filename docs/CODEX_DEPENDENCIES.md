# Controlled dependencies for the NEW isolated Codex path

`src/server/agents/codex-dependencies.ts` exposes
`prepareCodexDependencies(stage, signal?): Promise<CodexDependencyReport>`.
It is deliberately independent of the legacy dependency installer. The caller must
supply a **disposable, audited stage**, never the original project directory. This
module has no authority to discover the original workspace or execute generated code
on the host. The parent Codex task owns invocation and evidence/checkpoint handling.

## Fail-closed policy

- Only Node roots `''`, `client`, `backend`, and `server` are discovered. Other
  directories are not implicitly installed. Each discovered manifest requires a
  regular-file `package-lock.json`, npm lock version 2 or 3.
- Manifest/lock declarations reject URL/file/git/path/alias dependencies. Every
  non-root locked package requires a strong integrity digest and an HTTPS
  `registry.npmjs.org` tarball URL, with no credentials, port, query or fragment.
  Symlink package entries, unsafe paths, workspaces and overrides are refused.
  This conservative policy can block valid but unsupported npm configurations.
- Cache provisioning is an **operator/platform action**, not a model capability.
  `GS_CODEX_NPM_CACHE` must be an absolute, separately trusted, platform-owned
  directory with npm's `_cacache` subdirectory. Do not point it at a generated
  workspace or user/model-writable cache. Protect ownership/permissions outside
  the app; setting this variable asserts that the operator reviewed the cache.
  The cache must be readable by container uid 10001. Symlink bind paths are refused.
- No cache is configured by default. With no trusted cache, dependency preparation
  uses the **controlled dependency download path** described below instead of
  returning blocked. A missing `package-lock.json` is then generated *inside the
  disposable copy only* (the real project is never rewritten) and reported as
  `lockfileGenerated`. Unsafe manifests stay **blocked** even on that path.
  Installing without a trusted cache requires the restricted proxy; if the proxy,
  DNS or registry cannot be reached the result is **blocked/failed**, never passed.

## Controlled dependency download

Dependency download never uses the host's npm/pip and never runs generated code
online. A temporary Docker network is created with `--internal` (no default
route). A dedicated proxy container is the only member additionally attached to
the default bridge, and it:

- accepts only `CONNECT` to `registry.npmjs.org`, `pypi.org` and
  `files.pythonhosted.org` on port 443; every other method, host, port or
  plaintext request is refused;
- resolves those hosts through a trusted DNS path and rejects any non-public
  IPv4 answer (including the `198.18.0.0/15` fake-IP range), then pins the
  validated address into the socket;
- keeps TLS end-to-end (no interception, no credential injection) and logs no
  bodies, headers or credentials.

The installer/downloader container joins only the internal network, runs uid
10001 with a read-only root, no capabilities and bounded CPU/memory/PIDs, and
receives no project source beyond the manifests/wheels it needs. Because local
system DNS on this machine answers with fake-IP addresses, the proxy falls back
to well-known public resolvers contacted by literal IP with correct SNI; a
literal private/reserved pin is refused rather than silently accepted. The
network, proxy and any downloader container are removed and their removal is
verified before the step reports success.

## Container contract

The platform inspects the local Linux `gs-codex-worker:0.150.1` image and uses the
resulting immutable image ID with `--pull never`. The fixed entrypoint is
`/usr/local/bin/node`, executing a constant platform-owned bootstrap (not project
code). The bootstrap copies only package.json/package-lock.json to tmpfs, copies
only `_cacache` into a writable tmpfs cache, then invokes fixed npm arguments:

```text
ci --ignore-scripts --offline --cache=/tmp/cache
--registry=https://registry.npmjs.org --include=dev --no-audit --no-fund
--update-notifier=false --loglevel=error
--userconfig=/dev/null --globalconfig=/dev/null
```

The process runs uid/gid 10001, read-only container root, no capabilities,
no-new-privileges, bounded CPU/memory/PIDs and tmpfs. The package root and trusted
cache are read-only bind mounts. The **only writable host mount** is that root's
`node_modules` directory in the disposable stage. Host/project npmrc, model keys,
NODE_OPTIONS, Docker socket, original source, and the model broker are never
passed to npm. The npm subprocess receives only a fixed PATH, HOME, and CI.

Isolated containers that execute an interpreter or toolchain stage their work on
`/tmp`, which is mounted with an explicit `exec` option. Docker's `--tmpfs`
default is `noexec`, and mapping an executable segment from a `noexec` tmpfs fails
with `failed to map segment from shared object` (observed for Python extension
modules). `exec` here is inside an already read-only, capability-free,
network-free container; it is not host execution.

The container has `--network none`. There is no automatic network provisioning,
bridge/LAN access, registry proxy, or connection to the Unix model gateway. That
gateway's Responses allowlist is not an npm registry authorization mechanism.
With a trusted cache configured, no download path exists at all. Without one, only
the controlled dependency proxy described above is used; this code never grants
general network access to generated work.

Lifecycle scripts (including install/postinstall/prepare) are always skipped.
Native modules requiring scripts, generated clients, or packages needing uncached
artifacts may remain unusable. A passed install **does not prove build, test,
preview, native binary, or application readiness**.

## Python backend verification

`src/server/agents/codex-python-verification.ts` gives Python roots the same
treatment instead of a blanket "unsupported" block:

1. Requirements are parsed as metadata only. `requirements-dev.txt` (preferred) or
   `requirements.txt` may include `-r` chains; URLs, VCS, editable/local paths,
   indexes, hashes and installer options are refused, as are symlinked or oversized
   files. `pytest` is added if no test runner is declared. `pyproject.toml`-only
   projects report **blocked** rather than guessing a build backend.
2. Binary wheels are downloaded by a separate container that mounts only the
   validated requirements text and a wheel output directory — no project source and
   no credentials — through the same restricted proxy.
3. A second container with `--network none` creates a virtual environment on its
   tmpfs, installs strictly from those wheels (`--no-index --only-binary=:all:`),
   runs `compileall`, then runs `pytest` with a JUnit report.

`passed` requires a parsed JUnit report with at least one test, zero
failures/errors, zero skips and a success exit code. Collection errors, missing
tests, skipped-only runs and unparsable reports are **failed/blocked**, never
passed. Checks report collected/skipped/failure counts, the pytest exit code and a
bounded output tail as evidence; failures caused by unavailable external services
(MySQL/Redis) still surface as real failures and must be triaged, not hidden.

## Evidence, cancellation, and auditing

The report includes overall `status: passed | blocked | failed`, a non-secret
reason, and per-root `status`, `installed`, and reason. `passed` requires successful
`npm ci` for every discovered root and verified removal of each helper container.
No Node roots is blocked rather than a vacuous pass. Partial prior-root installs
may exist after a later root fails: the overall report is failed, never ready.
The parent must preserve/report this evidence and independently run any build or
test inside its existing isolated worker, without executing generated code on the
host. Do not interpret preparation success as acceptance evidence.

Install commands have a ten-minute timeout. Cancellation or timeout kills the CLI,
then separately runs `docker rm --force` without the cancelled signal and verifies
absence using `docker ps --all`. Cleanup has its own bounded operations. Failed
cleanup is failed evidence (daemon unavailability cannot prove removal); platform
operators must investigate any Docker resources left after daemon failure.
Failed/cancelled root output is removed. A caller must not concurrently mutate or
run another worker in the stage while provisioning.

Only `node_modules/**` (including npm's hidden lock and package bin symlinks) are
allowed dependency outputs. The original manifest/lock/config files are read-only,
not rewritten. Existing stage `node_modules` is disposable and replaced, never
copied from the original. The stage inventory/snapshot audit already excludes
`node_modules`; keep that exclusion explicit, never include generated dependencies
in source change sets, and continue auditing all source/lock/config changes. This
module changes no parent hooks or audit code.

## Dedicated tests

```text
pnpm exec vitest run tests/unit/codex-dependencies.test.ts
```

The tests mock Docker, not npm's install success in a real container. They cover
flags/mounts, lock/URL/spec/integrity rejection, absent cache/lock/install, root
scope, nonzero install, pre/in-flight cancellation, timeout and cleanup failure.
They are policy/unit evidence only; **no actual offline install or build is claimed**.
