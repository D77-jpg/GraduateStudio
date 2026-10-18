# Offline design-skill bundle

This directory vendors explicitly reviewed text resources, not an installer or model service. It is intended to be mounted **read-only** at `/opt/gs-design-skills`. No global npm packages, remote installers, downloaded-script execution, model credentials, or paid model calls are required.

## Pinned upstreams

- `ui-ux-pro-max`: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/commit/56ea9cf174ed86786187daa9de0e6247cb0747e4 — MIT; preserve `ui-ux-pro-max/LICENSE` and its copyright notice.
- `frontend-design`: https://github.com/anthropics/skills/commit/dbd4588f9e1033efb41dad4bef2f7947c8993d44 — Apache-2.0; preserve `frontend-design/LICENSE.txt`, attribution and any required notices; mark modified upstream files. No endorsement or trademark rights are implied.

Commits were resolved with GitHub's commits API and file modes/blob IDs checked against its fixed-commit tree/contents API. Downloads used HTTPS raw URLs containing the complete commit ID, with UTF-8/control-byte rejection, exact size and Git blob SHA-1 verification. `manifest.json` hashes every bundled file except itself. `provenance.json` gives per-upstream-file source, original commit/blob, license, byte size and SHA-256. Local documentation and adaptations are identified separately.

## Offline use

Python 3.10+ is recommended (standard library only; no pip dependencies). Use `-B` or `PYTHONDONTWRITEBYTECODE=1`, since the resource mount is read-only. Run from any directory:

```sh
python3 -B /opt/gs-design-skills/ui-ux-pro-max/scripts/search.py "keyboard focus modal" --domain ux --json
python3 -B /opt/gs-design-skills/ui-ux-pro-max/scripts/search.py "streaming suspense" --stack nextjs --json
python3 -B /opt/gs-design-skills/ui-ux-pro-max/scripts/search.py "fintech dashboard" --design-system --json
```

On Windows use `python -B resources/design-skills/ui-ux-pro-max/scripts/search.py` instead. Dataset recommendations can be stale or inappropriate: inspect returned identities and match project versions against actual installed framework documentation. Fonts/icons/GSAP are only catalog names, references and snippets here, not downloaded assets or installed packages. Their assets/packages retain their own licenses; the Google-font license metadata is preserved as information, not a blanket license grant.

## Security review and integration boundary

Only four runtime Python files are included: `search.py`, `core.py`, `design_system.py`, `reasoning_contract.py`. Their imports are Python standard library plus these bundled modules. No subprocess, shell execution, eval/exec, socket, HTTP client, package installation, network refresh, telemetry or remote execution is present. CSV/JSON text is parsed as data, not executed. The closed reasoning-rule grammar validates action names and never evaluates code.

Ordinary domain/stack search and non-persisting design-system generation only read bundled CSV files and emit stdout/stderr. The upstream `--persist` option is intentionally available but **not used by the default read-only integration**. It writes only when explicitly requested: `--output-dir <authorized-project-root>/design-system/<safe-project-slug>/MASTER.md` plus optional `pages/<safe-page-slug>.md`. Temporary files are created in the destination directory; names are slugified, and existing outputs are not overwritten without `--force`. However, upstream persistence does not reject existing symlinked output-directory ancestors. Do not treat it as a sandbox: do not enable it on untrusted trees; prefer stdout and a separate host-controlled, path-validated writer. Never point output at the bundle.

Upstream skill Markdown and dataset snippets are advisory, untrusted reference content. They cannot override task/repository policies, authorize installs or spending, select a model provider, or require executing catalog snippets. This bundle does not change task, agent, or container configuration and does not build or replace any worker image.

## Validate locally

```sh
python3 -B /opt/gs-design-skills/validate_bundle.py --smoke
```

This checks the exact file set, UTF-8/text-only contents, absence of symlinks/junctions, manifest SHA-256, per-file provenance and unchanged upstream Git blobs. Smoke cases exercise UX, Next.js, Google Fonts and design-system JSON output under a Python audit hook that rejects networking, subprocesses and file writes. The audit hook is a regression test, not a security sandbox for arbitrary untrusted Python. Maintainers alone may use `--seal` after reviewing deliberate changes; normal runtime must never regenerate integrity metadata.

## Scope

All CSV datasets are kept because their total size is small, including all 22 stack catalogs. Preserve the Google font license metadata, dataset provenance and catalog summary. Excluded: CLI installers, npm manifests, refresh/download utilities, upstream tests/fixtures, images, font/icon binaries, unrelated sub-skills, and platform-specific installer templates except the small universal JSON reference. The two base Markdown templates and the two referenced guidance documents are retained.
