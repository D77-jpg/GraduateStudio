#!/usr/bin/env python3
"""Offline integrity/security smoke test for the local text-only skill bundle.

This host-authored helper never downloads or installs anything. --seal is for
maintainers after reviewing deliberate vendoring edits; normal mode is read-only.
"""
import argparse
import ast
import hashlib
import json
from pathlib import Path
import re
import runpy
import sys
import io
from contextlib import redirect_stdout

ROOT = Path(__file__).resolve().parent
SKILLS = [
    {"id": "ui-ux-pro-max", "revision": "56ea9cf174ed86786187daa9de0e6247cb0747e4", "source": "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill", "license": "MIT"},
    {"id": "frontend-design", "revision": "dbd4588f9e1033efb41dad4bef2f7947c8993d44", "source": "https://github.com/anthropics/skills", "license": "Apache-2.0"},
]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def inventory():
    result = []
    for path in sorted(ROOT.rglob("*"), key=lambda item: item.relative_to(ROOT).as_posix()):
        if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
            raise ValueError(f"Link rejected: {path}")
        if path.is_dir():
            continue
        relative = path.relative_to(ROOT).as_posix()
        if relative == "manifest.json":
            continue
        data = path.read_bytes()
        text = data.decode("utf-8", errors="strict")
        if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", text):
            raise ValueError(f"Binary/control bytes rejected: {relative}")
        result.append({"path": relative, "sha256": digest(data)})
    return result


def seal():
    provenance_path = ROOT / "provenance.json"
    records = json.loads(provenance_path.read_text(encoding="utf-8"))
    for record in records:
        path = ROOT / record["path"]
        actual = path.read_bytes()
        if record["path"] == "ui-ux-pro-max/SKILL.md":
            record.setdefault("upstreamSha256", record["sha256"])
            record.setdefault("upstreamBytes", record["bytes"])
            record["modifications"] = "Command path adapted to /opt/gs-design-skills with python3 -B; local safety notice added. All other upstream files are byte-for-byte copies."
        record["sha256"] = digest(actual)
        record["bytes"] = len(actual)
    provenance_path.write_text(json.dumps(records, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    manifest = {"version": 1, "skills": SKILLS, "files": inventory()}
    (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n")


def smoke():
    scripts = ROOT / "ui-ux-pro-max/scripts"
    allowed_imports = {"argparse", "json", "sys", "io", "csv", "difflib", "re", "pathlib", "math", "collections", "os", "tempfile", "datetime", "core", "design_system", "reasoning_contract"}
    for path in sorted(scripts.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            names = [alias.name.split(".")[0] for alias in node.names] if isinstance(node, ast.Import) else ([node.module.split(".")[0]] if isinstance(node, ast.ImportFrom) and node.module else [])
            if any(name not in allowed_imports for name in names):
                raise AssertionError(f"Unexpected import in {path}: {names}")
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in {"eval", "exec", "compile", "__import__"}:
                raise AssertionError(f"Dynamic execution in {path}")
    # Audit hooks reject network, subprocess and ALL writes during runtime smoke.
    def audit(event, args):
        if event.startswith(("socket.", "subprocess.", "urllib.", "http.client.")) or event in {"os.system", "os.mkdir", "os.remove", "os.rename", "os.link", "os.symlink"}:
            raise AssertionError(f"Forbidden runtime effect: {event}")
        if event == "open":
            mode, flags = args[1], args[2]
            if (isinstance(mode, str) and any(c in mode for c in "wax+")) or (isinstance(flags, int) and flags & (1 | 2 | 64 | 512 | 1024)):
                raise AssertionError(f"Unexpected write: {args[0]}")
    sys.addaudithook(audit)
    sys.path.insert(0, str(scripts))
    entry = str(scripts / "search.py")
    cases = [
        ["keyboard focus modal", "--domain", "ux", "--json"],
        ["streaming suspense", "--stack", "nextjs", "--json"],
        ["variable sans serif", "--domain", "google-fonts", "--json"],
        ["fintech dashboard", "--design-system", "--json"],
    ]
    for args in cases:
        sys.argv = [entry, *args]
        output = io.StringIO()
        with redirect_stdout(output):
            runpy.run_path(entry, run_name="__main__")
        result = json.loads(output.getvalue())
        assert "error" not in result, result
        if "--design-system" in args:
            assert result["design_system"]["colors"] and result["persistence"] is None
        else:
            assert result["count"] > 0, result
        print("PASS offline, no writes/network/subprocess:", " ".join(args))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seal", action="store_true", help="Explicitly regenerate hashes after reviewed maintenance edits")
    parser.add_argument("--smoke", action="store_true", help="Run reviewed search modes under a no-write/no-network audit hook")
    args = parser.parse_args()
    sys.dont_write_bytecode = True
    if args.seal:
        seal()
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    assert set(manifest) == {"version", "skills", "files"}
    assert manifest["version"] == 1 and manifest["skills"] == SKILLS
    assert manifest["files"] == inventory(), "File set or SHA-256 mismatch"
    provenance = json.loads((ROOT / "provenance.json").read_text(encoding="utf-8"))
    for record in provenance:
        actual = (ROOT / record["path"]).read_bytes()
        assert digest(actual) == record["sha256"] and len(actual) == record["bytes"]
        if "modifications" not in record:
            assert hashlib.sha1(b"blob " + str(len(actual)).encode("ascii") + b"\0" + actual).hexdigest() == record["blob"]
    print(f"PASS manifest: {len(manifest['files'])} hashed files; {sum((ROOT / row['path']).stat().st_size for row in manifest['files'])} bytes excluding manifest")
    if args.smoke:
        smoke()
        assert manifest["files"] == inventory(), "Runtime changed the bundle"


if __name__ == "__main__":
    main()
