import type { AcceptanceCheck, AcceptanceCheckStatus, AcceptanceReport } from "./acceptance";

export type RepairIssueCategory = "dependency" | "build" | "test" | "environment" | "unknown";
export interface RepairIssue {
  id: string;
  checkId: string;
  title: string;
  paths: string[];
  evidence: string;
  category: RepairIssueCategory;
}
export interface RepairDiagnostics {
  issues: RepairIssue[];
  signature: string;
  /** Retained separately from issues so regressions include previously successful checks. */
  checkStatuses: Record<string, AcceptanceCheckStatus>;
  /** Missing failure details are not evidence that two attempts failed identically. */
  incompleteCheckIds: string[];
  /** Evidence acquisition failures, never actionable repair issues. */
  incompleteReasons: Record<string, string>;
}

/** Gate planning on captured causes, not failure names/counts or ordinary console errors. */
export function hasCompleteRepairDiagnostics(
  diagnostics: RepairDiagnostics,
  checkId?: string,
): boolean {
  if (checkId) {
    return (
      !diagnostics.incompleteCheckIds.includes(checkId) &&
      diagnostics.issues.some((issue) => issue.checkId === checkId)
    );
  }
  return diagnostics.incompleteCheckIds.length === 0;
}
export interface RepairDiagnosticsComparison {
  resolvedIds: string[];
  newIds: string[];
  persistentIds: string[];
  regressedCheckIds: string[];
  stalled: boolean;
}

const TRUNCATED =
  /\[输出已截断\]|（输出已截取）|\[(?:output )?truncated\]|output (?:was |has been )?truncated/i;
const TRUNCATION_NOTE = "Output truncated; important failure evidence may be missing.";
const DEPENDENCY =
  /Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Could not resolve|Failed to resolve import|Module not found|Can't resolve|TS2307|Missing script:|缺少.*依赖/i;
const ENVIRONMENT =
  /(?:Required tool .* unavailable|command not found|is not recognized|ENOENT|EACCES|EPERM|timeout|执行时限|缺少所需工具|无法执行检查|工程检查已取消)/i;
const BUILD_ERROR =
  /(?:\berror TS\d+:|\bTS\d+:|\bSyntaxError:|\bTypeError:|\bReferenceError:|\bType error:|\[ERROR\]|\[plugin:[^\]]+\]|^\s*Error:|^\s*error:|^\s*ERROR\b|^.*\berror during build:)/i;
const ASSERTION =
  /(?:AssertionError|ERR_ASSERTION|^\s*(?:error:|expected:|actual:|operator:|failureType:)|^\s*(?:Expected|Received):)/i;
const FILE =
  /(?:file:\/\/\/)?(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?(?:[\w.@-]+[\\/])*[\w.@-]+\.(?:[cm]?[jt]sx?|vue|svelte|java|kt|json|xml|html|css|scss)(?::\d+(?::\d+)?)?/g;

/** No Node dependencies: this module is also consumed by the client. */
function hash(text: string): string {
  let a = 2166136261;
  let b = 5381;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ text.charCodeAt(i);
  }
  return `${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
}

function clean(text: string): string {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
}

function projectPath(raw: string, checkId: string): string | undefined {
  let file = raw
    .replace(/\\/g, "/")
    .replace(/^file:\/\/\//, "")
    .replace(/:\d+(?::\d+)?$/, "");
  const absolute = /^(?:[A-Za-z]:\/|\/)/.test(file);
  // Reject traversal, not just normalize it into an apparently trustworthy path.
  if (file.split("/").includes("..")) return undefined;
  const workspace = file.match(/(?:^|\/)\.workspace\/[^/]+\/(.+)$/);
  if (workspace) file = workspace[1];
  else if (absolute) {
    const subproject = file.match(/(?:^|\/)((?:client|backend|server)\/.+)$/);
    if (!subproject) return undefined;
    file = subproject[1];
  }
  file = file.replace(/^\.\//, "");
  if (!file || file.startsWith("/") || /^[A-Za-z]:/.test(file)) return undefined;
  if (file.split("/").some((part) => !part || part === "." || part.startsWith("-")))
    return undefined;
  if (file.split("/").includes("node_modules")) return undefined;
  // Paths relative to a command's working directory need a project prefix.
  if (!/^(?:client|backend|server)\//.test(file)) {
    if (checkId.startsWith("frontend-")) file = `client/${file}`;
    else if (checkId.startsWith("backend-") && checkId !== "backend-verify")
      file = `backend/${file}`;
    else if (checkId === "backend-verify") file = `server/${file}`;
  }
  return file;
}

function pathsIn(text: string, checkId: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(FILE)].flatMap((match) => {
        const path = projectPath(match[0], checkId);
        return path ? [path] : [];
      }),
    ),
  ].sort();
}

function normalized(text: string, checkId: string): string {
  return clean(text)
    .replace(FILE, (path) => projectPath(path, checkId) ?? "<external-path>")
    .replace(/(^|[\s'"(])(?:[A-Za-z]:[\\/]|\/)(?:[^\s'"<>]+[\\/])[^\s'"<>]*/g, "$1<temporary-root>")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds|seconds|s)\b/gi, "<duration>")
    .replace(/\(\s*<duration>\s*\)/g, "")
    .replace(/\b(?:duration_ms|durationMs)\s*[:=]\s*\d+(?:\.\d+)?/g, "duration=<duration>")
    .replace(/\s+/g, " ")
    .trim();
}

function category(text: string, fallback: RepairIssueCategory): RepairIssueCategory {
  if (DEPENDENCY.test(text)) return "dependency";
  if (ENVIRONMENT.test(text)) return "environment";
  return fallback;
}

function makeIssue(
  check: AcceptanceCheck,
  title: string,
  detail: string[],
  truncated: boolean,
  kind: RepairIssueCategory,
): RepairIssue {
  const semanticTitle = normalized(title, check.id);
  const semanticDetails = [
    ...new Set(detail.map((line) => normalized(line, check.id)).filter(Boolean)),
  ].sort();
  const paths = pathsIn([title, ...detail].join("\n"), check.id);
  const key = JSON.stringify([check.id, kind, semanticTitle, paths, semanticDetails]);
  // Evidence contains selected diagnostic lines, never a copy or sample of the full report.
  // Bound individual pathological lines, explicitly preserving the fact of missing evidence.
  let clipped = false;
  const evidence = [title, ...detail].filter(Boolean).map((line) => {
    const safe = normalized(line, check.id);
    if (safe.length <= 1200) return safe;
    clipped = true;
    return `${safe.slice(0, 1200)} [diagnostic line truncated]`;
  });
  if (truncated || clipped) evidence.push(TRUNCATION_NOTE);
  return {
    id: `${check.id}:${hash(key)}`,
    checkId: check.id,
    title: semanticTitle,
    paths,
    evidence: [...new Set(evidence)].join("\n"),
    category: kind,
  };
}

interface NamedFailure {
  title: string;
  index: number;
  path?: string;
}
function namedFailures(lines: string[]): NamedFailure[] {
  // Vitest's detailed FAIL section is authoritative; its earlier × summary duplicates it.
  const detailed = lines.flatMap((line, index) => {
    const fail = line.match(/^\s*FAIL\s+(.+?)\s*>\s*(.+)$/);
    if (fail) return [{ title: `${fail[1]} > ${fail[2]}`, index, path: fail[1] }];
    const suite = line.match(/^\s*FAIL\s+(.+?\.(?:[cm]?[jt]sx?))(?:\s+\[.*\])?\s*$/);
    return suite ? [{ title: suite[1], index, path: suite[1] }] : [];
  });
  if (detailed.length) return detailed;
  let group: string | undefined;
  return lines.flatMap((line, index) => {
    const header = line.match(/^\s*[❯×]\s+([^\s]+\.(?:[cm]?[jt]sx?))\s+\(/);
    if (header) {
      group = header[1];
      return [];
    }
    const node = line.match(/^\s*✖\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?\s*$/);
    if (node && !/^(?:failing tests:?|tests?\s+\d+|suites?\s+\d+)$/i.test(node[1]))
      return [{ title: node[1], index }];
    const vitest = line.match(/^\s*[×✕]\s+(.+?)(?:\s+\d+(?:\.\d+)?\s*m?s)?\s*$/);
    if (vitest && group) return [{ title: `${group} > ${vitest[1]}`, index, path: group }];
    const tap = line.match(/^\s*not ok \d+\s*-\s*(.+)$/);
    return tap ? [{ title: tap[1], index }] : [];
  });
}

/** Pure conversion of failed/blocked checks into actionable, deterministic groups. */
export function buildRepairDiagnostics(report: AcceptanceReport): RepairDiagnostics {
  const issues: RepairIssue[] = [];
  const incompleteCheckIds: string[] = [];
  const incompleteReasons: Record<string, string> = {};
  const markIncomplete = (id: string, reason: string) => {
    incompleteCheckIds.push(id);
    incompleteReasons[id] = incompleteReasons[id] ? `${incompleteReasons[id]} ${reason}` : reason;
  };
  const checkStatuses: Record<string, AcceptanceCheckStatus> = {};
  for (const check of report.checks) {
    const old = checkStatuses[check.id];
    // Multiple source checks may share an id; a passing sibling must not hide a failure.
    if (!old || check.status === "failed" || (check.status === "blocked" && old !== "failed"))
      checkStatuses[check.id] = check.status;
    if (check.status !== "failed" && check.status !== "blocked") continue;
    const evidence = check.failureEvidence?.trim() ? check.failureEvidence : check.output;
    const lines = clean(evidence).split("\n");
    const truncated = check.failureEvidence?.trim()
      ? !!check.failureEvidenceIncomplete
      : TRUNCATED.test(check.output) || check.output.length >= 16_000;
    const isTest = /test|verify/.test(check.id);
    const failures = isTest ? namedFailures(lines) : [];
    if (failures.length) {
      const groups = new Map<string, { title: string; details: string[] }>();
      failures.forEach((failure, offset) => {
        // Vitest may list several FAIL suites consecutively, then print their shared cause once.
        let last = offset;
        while (last + 1 < failures.length && failures[last + 1].index === failures[last].index + 1)
          last++;
        const end = failures[last + 1]?.index ?? lines.length;
        const start = last === offset ? failure.index + 1 : failures[last].index + 1;
        const details: string[] = [];
        const preceding = lines[failure.index - 1];
        if (preceding && /^\s*test at\s+/.test(preceding)) details.push(preceding);
        // Only assertion details attached to an actual failure, not expected error logs.
        for (let index = start; index < end; index++) {
          const line = lines[index];
          if (/^\s*(?:[✔✓×✖]|FAIL\s|stderr\s*\||stdout\s*\||# Subtest:|not ok |ok \d+)/.test(line))
            break;
          if (
            ASSERTION.test(line) ||
            BUILD_ERROR.test(line) ||
            /^\s*(?:location:|at\s+|❯\s+\S+\.(?:[cm]?[jt]sx?))/.test(line)
          )
            details.push(line);
        }
        const key = normalized(failure.title, check.id);
        const group = groups.get(key) ?? { title: failure.title, details: [] };
        group.details.push(...details);
        groups.set(key, group);
      });
      for (const group of groups.values()) {
        issues.push(
          makeIssue(
            check,
            group.title,
            group.details,
            truncated,
            category(group.details.join("\n"), "test"),
          ),
        );
        if (
          [group.title, ...group.details].some((line) => normalized(line, check.id).length > 1200)
        )
          markIncomplete(
            check.id,
            "An individual diagnostic line was clipped; reacquire its full cause.",
          );
        if (
          !group.details.some(
            (line) => ASSERTION.test(line) || BUILD_ERROR.test(line) || DEPENDENCY.test(line),
          )
        )
          markIncomplete(
            check.id,
            `Named failure ${normalized(group.title, check.id)} has no captured assertion or startup cause.`,
          );
      }
      // Truncation may hide additional failures even if some names survived.
      if (truncated) markIncomplete(check.id, TRUNCATION_NOTE);
      continue;
    }
    // Root errors only for builds, or unmistakable loader/dependency failures in tests.
    const explicitStartupFailure =
      /(?:Startup Error|Unhandled Errors?|Error during (?:setup|startup)|failed to load config|^node:internal\/|^Error \[ERR_[A-Z_]+\]:|^Require stack:)/im.test(
        clean(evidence),
      );
    const rootLines = lines.filter(
      (line) =>
        !TRUNCATED.test(line) &&
        (DEPENDENCY.test(line) ||
          ENVIRONMENT.test(line) ||
          ((!isTest || explicitStartupFailure) && BUILD_ERROR.test(line))),
    );
    if (rootLines.length) {
      const strong = rootLines.filter(
        (line) =>
          DEPENDENCY.test(line) ||
          ENVIRONMENT.test(line) ||
          !/error during build:|BUILD FAILURE|failed to execute goal/i.test(line),
      );
      const selected = strong.length ? strong : rootLines;
      const locations = selected.flatMap((line) => {
        const preceding = lines[lines.indexOf(line) - 1];
        return preceding &&
          pathsIn(preceding, check.id).length &&
          !/warning|stderr|stdout/i.test(preceding)
          ? [preceding]
          : [];
      });
      const kind = category(selected.join("\n"), isTest ? "unknown" : "build");
      issues.push(
        makeIssue(check, selected[0].trim(), [...locations, ...selected], truncated, kind),
      );
      if (truncated) markIncomplete(check.id, TRUNCATION_NOTE);
    } else if (check.status === "blocked" && !check.command && !truncated) {
      // Planning/scanning checks are already concise structured explanations, not logs.
      const details = lines.map((line) => line.trim()).filter(Boolean);
      if (details.length)
        issues.push(
          makeIssue(check, details[0], details, false, category(details.join("\n"), "unknown")),
        );
      else markIncomplete(check.id, "Check blocked; no diagnostic evidence was captured.");
    } else {
      markIncomplete(
        check.id,
        (isTest
          ? "Test check failed or blocked, but no named failure with assertion or explicit startup cause was captured."
          : "Check failed or blocked, but no actionable root error was captured.") +
          (truncated ? ` ${TRUNCATION_NOTE}` : "") +
          " Reacquire full diagnostic output before generating a repair plan; do not infer a cause from counts or ordinary console logs.",
      );
    }
  }
  const unique = [...new Map(issues.map((issue) => [issue.id, issue])).values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  return {
    issues: unique,
    signature: hash(JSON.stringify(unique.map((issue) => issue.id))),
    checkStatuses,
    incompleteCheckIds: [...new Set(incompleteCheckIds)].sort(),
    incompleteReasons,
  };
}

/** Compare issue identities, not report text, timings, warning counts or summary totals. */
export function compareRepairDiagnostics(
  previous: RepairDiagnostics,
  current: RepairDiagnostics,
): RepairDiagnosticsComparison {
  const before = new Set(previous.issues.map((issue) => issue.id));
  const after = new Set(current.issues.map((issue) => issue.id));
  const resolvedIds = [...before].filter((id) => !after.has(id)).sort();
  const newIds = [...after].filter((id) => !before.has(id)).sort();
  const persistentIds = [...after].filter((id) => before.has(id)).sort();
  const regressedCheckIds = Object.keys(current.checkStatuses)
    .filter(
      (id) =>
        previous.checkStatuses[id] === "passed" &&
        ["failed", "blocked"].includes(current.checkStatuses[id]),
    )
    .sort();
  const stalled =
    after.size > 0 &&
    !resolvedIds.length &&
    !newIds.length &&
    !regressedCheckIds.length &&
    !previous.incompleteCheckIds.length &&
    !current.incompleteCheckIds.length;
  return { resolvedIds, newIds, persistentIds, regressedCheckIds, stalled };
}
