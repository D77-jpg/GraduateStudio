import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/server/agents/codex-dependency-network", () => ({
  dependencyDocker: vi.fn(),
  withDependencyNetwork: vi.fn(),
}));
import { dependencyDocker } from "../../src/server/agents/codex-dependency-network";
import { pythonStackIdentity } from "../../src/server/runtime/python-stack";
import {
  collectRuntimeRepairEvidence,
  parseRuntimeRepairObservation,
} from "../../src/server/runtime/codex-runtime-diagnostics";

const docker = vi.mocked(dependencyDocker);
const id = "a".repeat(64);
const owner = "io.graduatestudio.python-runtime";
const project = "project-one";
function resource() {
  return {
    Id: id,
    Name: `/${pythonStackIdentity(project).container("backend")}`,
    Config: {
      User: "10001:10001",
      Labels: {
        [owner]: "1",
        [`${owner}.project`]: pythonStackIdentity(project).key,
        [`${owner}.role`]: "backend",
      },
    },
    State: { Running: true, Paused: false, Restarting: false },
  };
}
function observation(extra: Record<string, unknown> = {}) {
  return {
    taskId: 9,
    taskState: "failed",
    failureCode: "MODEL_CONNECT_ERROR",
    endpoint: { serviceId: 2, port: 11434, hostKind: "loopback" },
    connectivity: "refused",
    result: "ok",
    ...extra,
  };
}
function ready(data = observation()) {
  docker
    .mockResolvedValueOnce(JSON.stringify(resource()))
    .mockResolvedValueOnce(JSON.stringify(data) + "\n")
    .mockResolvedValueOnce(JSON.stringify(resource()));
}
beforeEach(() => docker.mockReset());

describe("runtime repair evidence", () => {
  it.each(["任务 #9 失败修复", "任务9失败", "task #9 failed", "刚刚执行了任务 #9·失败，修复好来"])(
    "collects explicit identity: %s",
    async (message) => {
      ready();
      const report = await collectRuntimeRepairEvidence(project, message);
      expect(report).toMatchObject({
        version: 1,
        status: "collected",
        taskId: 9,
        taskState: "failed",
        failureCode: "MODEL_CONNECT_ERROR",
        connectivity: "refused",
        modelCalls: 0,
        needsUserAction: true,
      });
      expect(report?.issues.join(" ")).toContain("not the host");
      expect(report?.issues.join(" ")).toContain("not independent trusted verification");
      const args = docker.mock.calls[1][0];
      expect(args.slice(0, 8)).toEqual([
        "exec",
        "--workdir",
        "/source",
        id,
        "/tmp/venv/bin/python",
        "-B",
        "-c",
        expect.any(String),
      ]);
      expect(args.at(-1)).toBe("9");
      expect(docker.mock.calls.every((call) => call[2]! <= 20000)).toBe(true);
      expect(JSON.stringify(args)).not.toContain(message);
    },
  );
  it.each(["local connection failed", "任务 #9 请展示", "修复这个页面", "task# failed"])(
    "does not infer a missing identity: %s",
    async (message) => {
      const result = await collectRuntimeRepairEvidence(project, message);
      expect(result).toBeNull();
      expect(docker).not.toHaveBeenCalled();
    },
  );
  it.each([
    "任务 #9 任务10 失败",
    "task #9 and #10 failed",
    "任务9 #10失败",
    "task #-9 failed",
    "task #0 failed",
    "task #9;curl failed",
    "task #9007199254740992 failed",
    "task #9/10 failed",
    "task #9.5 failed",
  ])("blocks unsafe/ambiguous IDs: %s", async (message) => {
    expect(await collectRuntimeRepairEvidence(project, message)).toMatchObject({
      status: "blocked",
      taskId: null,
      modelCalls: 0,
    });
    expect(docker).not.toHaveBeenCalled();
  });
  it("accepts repeated identical IDs and never uses prompt commands or targets", async () => {
    ready();
    await collectRuntimeRepairEvidence(
      project,
      "task #9 failed; task #9 repair; docker exec evil curl http://secret",
    );
    expect(docker.mock.calls[0][0]).toEqual([
      "container",
      "inspect",
      pythonStackIdentity(project).container("backend"),
      "--format",
      expect.stringContaining('"Labels":{{json .Config.Labels}}'),
    ]);
    expect(docker.mock.calls[0][0].at(-1)).not.toContain("Env");
    expect(docker.mock.calls[1][0].join(" ")).not.toContain("evil");
  });
  it.each(["project", "role", "owner", "stopped", "id", "name"])(
    "refuses identity/state mismatch: %s",
    async (variant) => {
      const info = resource();
      if (variant === "project") info.Config.Labels[`${owner}.project`] = "other";
      if (variant === "role") info.Config.Labels[`${owner}.role`] = "worker";
      if (variant === "owner") info.Config.Labels[owner] = "0";
      if (variant === "stopped") info.State.Running = false;
      if (variant === "id") info.Id = "backend";
      if (variant === "name") info.Name = "/other";
      docker.mockResolvedValueOnce(JSON.stringify(info));
      expect(await collectRuntimeRepairEvidence(project, "task #9 failed")).toMatchObject({
        status: "blocked",
        connectivity: "blocked",
      });
      expect(docker).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["0", "root", "", "10002:10002"])(
    "refuses an unexpected backend user: %s",
    async (user) => {
      const info = resource();
      info.Config.User = user;
      docker.mockResolvedValueOnce(JSON.stringify(info));
      expect(await collectRuntimeRepairEvidence(project, "task #9 failed")).toMatchObject({
        status: "blocked",
      });
      expect(docker).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["replacement", "labels", "user", "stopped", "inspect_failure"])(
    "discards observations after runtime identity changes: %s",
    async (change) => {
      const after = resource();
      if (change === "replacement") after.Id = "b".repeat(64);
      if (change === "labels") after.Config.Labels[`${owner}.project`] = "other";
      if (change === "user") after.Config.User = "10001";
      if (change === "stopped") after.State.Running = false;
      docker
        .mockResolvedValueOnce(JSON.stringify(resource()))
        .mockResolvedValueOnce(JSON.stringify(observation()));
      if (change === "inspect_failure") docker.mockRejectedValueOnce(new Error("secret"));
      else docker.mockResolvedValueOnce(JSON.stringify(after));
      const report = await collectRuntimeRepairEvidence(project, "task #9 failed");
      expect(report).toMatchObject({
        status: "blocked",
        connectivity: "blocked",
        endpoint: { serviceId: null },
      });
      expect(report?.issues.join(" ")).toContain("discarded");
      expect(JSON.stringify(report)).not.toContain("secret");
      expect(docker).toHaveBeenCalledTimes(3);
      expect(docker.mock.calls[2][0]).toEqual(docker.mock.calls[0][0]);
    },
  );
  it("supports the pinned unprivileged numeric UID", async () => {
    const info = resource();
    info.Config.User = "10001";
    docker
      .mockResolvedValueOnce(JSON.stringify(info))
      .mockResolvedValueOnce(JSON.stringify(observation()))
      .mockResolvedValueOnce(JSON.stringify(info));
    expect(await collectRuntimeRepairEvidence(project, "task #9 failed")).toMatchObject({
      status: "collected",
    });
  });
  it("fails closed on inspection errors without exposing exception contents", async () => {
    docker.mockRejectedValueOnce(new Error("api_key=SECRET"));
    const report = await collectRuntimeRepairEvidence(project, "task #9 failed");
    expect(report?.status).toBe("blocked");
    expect(JSON.stringify(report)).not.toContain("SECRET");
    expect(docker).toHaveBeenCalledTimes(1);
  });
  it("reports unsupported runtime and missing task honestly", async () => {
    for (const result of ["unsupported", "missing"]) {
      ready(
        observation({
          result,
          taskState: result === "missing" ? "missing" : "unknown",
          connectivity: "not_configured",
          endpoint: { serviceId: null, port: null, hostKind: null },
        }),
      );
      expect(await collectRuntimeRepairEvidence(project, "task #9 failed")).toMatchObject({
        status: "blocked",
        needsUserAction: true,
      });
    }
  });
  it("propagates abort before and during Docker calls", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      collectRuntimeRepairEvidence(project, "task #9 failed", controller.signal),
    ).rejects.toThrow("cancelled");
    expect(docker).not.toHaveBeenCalled();
    const mid = new AbortController();
    docker.mockImplementationOnce(async (_args, signal) => {
      expect(signal).toBeDefined();
      mid.abort(new Error("stop now"));
      throw new Error("Docker failed");
    });
    await expect(
      collectRuntimeRepairEvidence(project, "task #9 failed", mid.signal),
    ).rejects.toThrow("stop now");
  });
  it("uses a bounded fixed socket-only script without service secrets or generation imports", async () => {
    ready();
    await collectRuntimeRepairEvidence(project, "task #9 failed");
    const script = docker.mock.calls[1][0][7];
    expect(script).toContain("signal.alarm(15)");
    expect(script).toContain("socket.create_connection((numeric,port),timeout=3)");
    expect(script).toContain("socket.getaddrinfo(host,port");
    expect(script).toContain("GenerationTask.model_service_id");
    expect(script.match(/os\.environ/g)).toHaveLength(1);
    expect(script).toContain("os.environ.get('MODEL_ENDPOINT_HOST_ALIAS')=='host.docker.internal'");
    for (const forbidden of [
      "error_message",
      "api_key",
      "config.code",
      "requests.",
      "urllib.request",
      "subprocess",
      "app.services.generation",
      "session.commit",
    ])
      expect(script).not.toContain(forbidden);
    expect(docker.mock.calls.flatMap((call) => call[0]).join(" ")).not.toMatch(
      /--privileged|--mount|network connect|--env/,
    );
  });
});

describe("pure safe runtime output parser", () => {
  it.each(["connected", "refused", "timeout", "dns_error", "blocked", "not_configured"])(
    "classifies %s",
    (connectivity) => {
      expect(
        parseRuntimeRepairObservation(JSON.stringify(observation({ connectivity })), 9)
          ?.connectivity,
      ).toBe(connectivity);
    },
  );
  it.each(["loopback", "private", "public", "local_name"])(
    "accepts only safe host classification %s",
    (hostKind) => {
      expect(
        parseRuntimeRepairObservation(
          JSON.stringify(observation({ endpoint: { serviceId: 1, port: 443, hostKind } })),
          9,
        )?.endpoint.hostKind,
      ).toBe(hostKind);
    },
  );
  it("strips unknown keys recursively and ignores arbitrary code/error/summary/keys", () => {
    const report = parseRuntimeRepairObservation(
      JSON.stringify(
        observation({
          api_key: "SECRET",
          code: "SECRET",
          error_message: "SECRET",
          failureSummary: "SECRET",
          issues: ["SECRET"],
          endpoint: {
            serviceId: 2,
            port: 11434,
            hostKind: "private",
            url: "http://SECRET",
            key: "SECRET",
          },
        }),
      ),
      9,
    );
    expect(report?.status).toBe("collected");
    expect(JSON.stringify(report)).not.toContain("SECRET");
    expect(report?.failureSummary).toBe("The task recorded a model connection failure.");
  });
  it.each([
    "noise\n" + JSON.stringify(observation()),
    JSON.stringify(observation()) + "\n{}",
    " " + JSON.stringify(observation()),
    "x".repeat(8193),
    JSON.stringify(observation({ taskId: 10 })),
    JSON.stringify(observation({ taskState: "SECRET" })),
    JSON.stringify(observation({ failureCode: "SECRET" })),
    JSON.stringify(observation({ connectivity: "SECRET" })),
    JSON.stringify(
      observation({ endpoint: { serviceId: "SECRET", port: 443, hostKind: "public" } }),
    ),
    JSON.stringify(observation({ endpoint: { serviceId: 1, port: 70000, hostKind: "public" } })),
    JSON.stringify(observation({ endpoint: { serviceId: null, port: null, hostKind: null } })),
  ])("rejects unsafe/oversize/malformed output", (text) =>
    expect(parseRuntimeRepairObservation(text, 9)).toBeNull(),
  );
});
