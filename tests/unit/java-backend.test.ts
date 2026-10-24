import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn, execFile: mocks.execFile }));

import {
  detectJavaSpringBackend,
  javaToolchain,
  startJavaBackend,
  waitForSpringHealth,
} from "@/server/runtime/java-backend";

const SPRING_POM = `<project><modelVersion>4.0.0</modelVersion><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId></parent><build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>`;

const roots: string[] = [];
const actualPlatform = process.platform;

type FakeChild = EventEmitter & { pid: number; stdout: EventEmitter; stderr: EventEmitter };
const children: FakeChild[] = [];

function projectFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "java-backend-unit-"));
  roots.push(root);
  return root;
}

function writePom(root: string, module: string, body: string): string {
  const directory = path.join(root, module);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "pom.xml");
  fs.writeFileSync(file, body);
  return file;
}

function usePlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function startOptions(overrides: Partial<Parameters<typeof startJavaBackend>[0]> = {}) {
  return {
    projectId: "project-1",
    directory: path.join(os.tmpdir(), "java-project", "server"),
    port: 8123,
    env: {} as Record<string, string | undefined>,
    ...overrides,
  };
}

function spawnCall() {
  return mocks.spawn.mock.calls[0] as [
    string,
    string[],
    {
      cwd: string;
      env: NodeJS.ProcessEnv;
      detached: boolean;
      windowsHide: boolean;
      shell?: boolean;
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  children.length = 0;
  mocks.execFile.mockImplementation(
    (
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => callback(null, "", ""),
  );
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4300 + children.length,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    }) as FakeChild;
    children.push(child);
    return child;
  });
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: actualPlatform, configurable: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

describe("Spring Boot project detection", () => {
  it("detects server/pom.xml with the Spring Boot Maven plugin", () => {
    const root = projectFixture();
    writePom(root, "server", SPRING_POM);
    expect(detectJavaSpringBackend(root)).toEqual({
      directory: path.join(root, "server"),
      module: "server",
    });
  });

  it("detects backend/pom.xml", () => {
    const root = projectFixture();
    writePom(root, "backend", SPRING_POM);
    expect(detectJavaSpringBackend(root)).toEqual({
      directory: path.join(root, "backend"),
      module: "backend",
    });
  });

  it("prefers the server module when both layouts exist", () => {
    const root = projectFixture();
    writePom(root, "server", SPRING_POM);
    writePom(root, "backend", SPRING_POM);
    expect(detectJavaSpringBackend(root)?.module).toBe("server");
  });

  it("rejects a Spring Boot pom without spring-boot-maven-plugin", () => {
    const root = projectFixture();
    writePom(
      root,
      "server",
      "<project><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>",
    );
    expect(detectJavaSpringBackend(root)).toBeNull();
  });

  it("rejects a Maven module that does not mention spring-boot", () => {
    const root = projectFixture();
    writePom(root, "server", "<project><artifactId>plain-java</artifactId></project>");
    expect(detectJavaSpringBackend(root)).toBeNull();
  });

  it("ignores client modules and a project-root pom", () => {
    const root = projectFixture();
    writePom(root, "client", SPRING_POM);
    fs.writeFileSync(path.join(root, "pom.xml"), SPRING_POM);
    expect(detectJavaSpringBackend(root)).toBeNull();
  });

  it("rejects a symlinked pom.xml", () => {
    const root = projectFixture();
    const pom = writePom(root, "server", SPRING_POM);
    const realLstat = fs.lstatSync.bind(fs) as unknown as (target: string) => fs.Stats;
    vi.spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike) =>
      String(target) === pom
        ? ({ isFile: () => true, isSymbolicLink: () => true, size: 32 } as unknown as fs.Stats)
        : realLstat(String(target))) as unknown as typeof fs.lstatSync);
    expect(detectJavaSpringBackend(root)).toBeNull();
  });

  it("rejects a pom.xml larger than 128KiB", () => {
    const root = projectFixture();
    writePom(root, "server", `${SPRING_POM}${" ".repeat(129 * 1024)}`);
    expect(detectJavaSpringBackend(root)).toBeNull();
  });

  it("accepts a pom.xml of exactly 128KiB", () => {
    const root = projectFixture();
    writePom(root, "server", SPRING_POM + " ".repeat(128 * 1024 - SPRING_POM.length));
    expect(detectJavaSpringBackend(root)?.module).toBe("server");
  });
});

describe("Java toolchain probing", () => {
  it("reports missing java and maven without printing their output", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.execFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(new Error("not found"), "raw java output", "raw maven output"),
    );
    await expect(javaToolchain()).resolves.toEqual({ java: false, mvn: false });
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("probes java -version and mvn via cmd.exe on Windows with a 5s bound", async () => {
    usePlatform("win32");
    mocks.execFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, "version output", ""),
    );
    await expect(javaToolchain()).resolves.toEqual({ java: true, mvn: true });
    const javaCall = mocks.execFile.mock.calls[0];
    const mavenCall = mocks.execFile.mock.calls[1];
    expect(javaCall[0]).toBe("java");
    expect(javaCall[1]).toEqual(["-version"]);
    expect(javaCall[2]).toMatchObject({ timeout: 5000, windowsHide: true });
    expect(mavenCall[0]).toBe("cmd.exe");
    expect(mavenCall[1]).toEqual(["/d", "/s", "/c", "mvn -v"]);
  });

  it("uses plain mvn on POSIX", async () => {
    usePlatform("linux");
    await javaToolchain();
    expect(mocks.execFile.mock.calls[1][0]).toBe("mvn");
  });

  it("refuses to spawn when the toolchain is missing", async () => {
    mocks.execFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(new Error("ENOENT"), "", ""),
    );
    await expect(startJavaBackend(startOptions())).rejects.toThrow(
      "本机未安装 Java 或 Maven，无法启动 Spring Boot 后端",
    );
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("refuses to spawn when java exists but maven does not", async () => {
    mocks.execFile.mockImplementation(
      (
        command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(command === "java" ? null : new Error("ENOENT"), "", ""),
    );
    await expect(startJavaBackend(startOptions())).rejects.toThrow(
      "本机未安装 Java 或 Maven，无法启动 Spring Boot 后端",
    );
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});

describe("Spring Boot backend process", () => {
  it("launches mvn with fixed arguments, cwd and an isolated process group on POSIX", async () => {
    usePlatform("linux");
    const log = vi.fn();
    const handle = await startJavaBackend(
      startOptions({ directory: path.join(os.tmpdir(), "java-project", "server"), log }),
    );
    const [command, args, options] = spawnCall();
    expect(command).toBe("mvn");
    expect(args).toEqual(["-B", "-q", "spring-boot:run"]);
    expect(options.cwd).toBe(path.join(os.tmpdir(), "java-project", "server"));
    expect(options.windowsHide).toBe(true);
    expect(options.detached).toBe(true);
    expect(options.shell).toBeUndefined();
    expect(handle.pid).toBe(4300);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain("project-1");
    await handle.stop();
  });

  it("forces SERVER_PORT, inherits the host env and preserves SPRING_PROFILES_ACTIVE", async () => {
    usePlatform("linux");
    vi.stubEnv("SPRING_PROFILES_ACTIVE", "dev");
    vi.stubEnv("SERVER_PORT", "9999");
    vi.stubEnv("INHERITED_FLAG", "host");
    const handle = await startJavaBackend(
      startOptions({ env: { SERVER_PORT: "1111", PROJECT_FLAG: "project" } }),
    );
    const env = spawnCall()[2].env;
    expect(env.SERVER_PORT).toBe("8123");
    expect(env.SPRING_PROFILES_ACTIVE).toBe("dev");
    expect(env.INHERITED_FLAG).toBe("host");
    expect(env.PROJECT_FLAG).toBe("project");
    await handle.stop();
  });

  it("runs maven through cmd.exe on Windows without shell:true", async () => {
    usePlatform("win32");
    const handle = await startJavaBackend(startOptions());
    const [command, args, options] = spawnCall();
    expect(command).toBe("cmd.exe");
    expect(args).toEqual(["/d", "/s", "/c", "mvn -B -q spring-boot:run"]);
    expect(options.windowsHide).toBe(true);
    expect(options.detached).toBe(false);
    expect(options.shell).toBeUndefined();
    expect(
      mocks.execFile.mock.calls.some(
        (call) => call[0] === "cmd.exe" && call[1]?.includes("mvn -v"),
      ),
    ).toBe(true);
    await handle.stop();
  });

  it("keeps only the last 8KiB, so an early port marker is discarded", async () => {
    usePlatform("linux");
    const handle = await startJavaBackend(startOptions());
    children[0].stdout.emit("data", Buffer.from("Port 8080 was already in use\n"));
    children[0].stdout.emit("data", Buffer.alloc(9000, 120));
    children[0].emit("exit", 1);
    expect(handle.failure()).toBe("后端进程已退出");
  });

  it("retains a marker located inside the last 8KiB", async () => {
    usePlatform("linux");
    const handle = await startJavaBackend(startOptions());
    children[0].stderr.emit("data", Buffer.alloc(9000, 120));
    children[0].stderr.emit("data", Buffer.from("EADDRINUSE"));
    children[0].emit("exit", 1);
    expect(handle.failure()).toBe("后端端口已被占用");
  });

  it("classifies a port already in use", async () => {
    usePlatform("linux");
    const handle = await startJavaBackend(startOptions());
    children[0].stdout.emit(
      "data",
      Buffer.from("Web server failed to start. Port 8080 was already in use."),
    );
    children[0].emit("exit", 1);
    expect(handle.failure()).toBe("后端端口已被占用");
  });

  it("classifies EADDRINUSE", async () => {
    usePlatform("linux");
    const handle = await startJavaBackend(startOptions());
    children[0].stderr.emit("data", Buffer.from("java.net.BindException: EADDRINUSE"));
    children[0].emit("exit", 1);
    expect(handle.failure()).toBe("后端端口已被占用");
  });

  it("classifies an unreachable database", async () => {
    usePlatform("linux");
    const handle = await startJavaBackend(startOptions());
    children[0].stderr.emit(
      "data",
      Buffer.from(
        "com.mysql.cj.jdbc.exceptions.CommunicationsException: Communications link failure",
      ),
    );
    children[0].emit("exit", 1);
    expect(handle.failure()).toBe("数据库不可达");
  });

  it("classifies a refused database connection", async () => {
    usePlatform("linux");
    const handle = await startJavaBackend(startOptions());
    children[0].stderr.emit("data", Buffer.from("java.net.ConnectException: Connection refused"));
    children[0].emit("exit", 1);
    expect(handle.failure()).toBe("数据库不可达");
  });

  it("classifies a Flyway failure", async () => {
    usePlatform("linux");
    const handle = await startJavaBackend(startOptions());
    children[0].stderr.emit(
      "data",
      Buffer.from("org.flywaydb.core.api.FlywayException: Validate failed"),
    );
    children[0].emit("exit", 1);
    expect(handle.failure()).toBe("数据库迁移失败(Flyway)");
  });

  it("falls back to a fixed exit message without leaking raw output", async () => {
    usePlatform("linux");
    const handle = await startJavaBackend(startOptions());
    children[0].stderr.emit("data", Buffer.from("Caused by: unexpected secret-token=abc"));
    children[0].emit("exit", 1);
    expect(handle.failure()).toBe("后端进程已退出");
    expect(handle.failure()).not.toContain("secret-token");
  });

  it("classifies a spawn error without exposing its message", async () => {
    usePlatform("linux");
    const handle = await startJavaBackend(startOptions());
    children[0].emit("error", new Error("spawn mvn ENOENT raw-detail"));
    expect(handle.failure()).toBe("后端进程已退出");
    expect(handle.failure()).not.toContain("ENOENT");
    expect(handle.failure()).not.toContain("raw-detail");
  });

  it("stops the POSIX process group once and is idempotent", async () => {
    usePlatform("linux");
    const handle = await startJavaBackend(startOptions());
    const first = handle.stop();
    const second = handle.stop();
    await Promise.all([first, second]);
    const kills = mocks.execFile.mock.calls.filter((call) => call[0] === "kill");
    expect(kills).toHaveLength(1);
    expect(kills[0][1]).toEqual(["-9", "--", `-${handle.pid}`]);
    expect(kills[0][2]).toMatchObject({ windowsHide: true });
  });

  it("does not record a failure after an intentional stop", async () => {
    usePlatform("linux");
    const handle = await startJavaBackend(startOptions());
    await handle.stop();
    children[0].emit("exit", 1);
    children[0].emit("error", new Error("killed"));
    expect(handle.failure()).toBeNull();
  });

  it("uses taskkill /F /T /PID on Windows", async () => {
    usePlatform("win32");
    const handle = await startJavaBackend(startOptions());
    await handle.stop();
    const taskkill = mocks.execFile.mock.calls.find((call) => call[0] === "taskkill");
    expect(taskkill).toBeDefined();
    expect(taskkill?.[1]).toEqual(["/F", "/T", "/PID", String(handle.pid)]);
    expect(taskkill?.[2]).toMatchObject({ windowsHide: true });
  });

  it("resolves silently when the kill command fails", async () => {
    usePlatform("linux");
    const handle = await startJavaBackend(startOptions());
    mocks.execFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(new Error("no such process"), "", ""),
    );
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it("kills the backend when the startup signal aborts", async () => {
    usePlatform("linux");
    const controller = new AbortController();
    const handle = await startJavaBackend(startOptions({ signal: controller.signal }));
    controller.abort();
    const kills = mocks.execFile.mock.calls.filter((call) => call[0] === "kill");
    expect(kills).toHaveLength(1);
    expect(handle.failure()).toBeNull();
  });

  it("does not spawn when the startup signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(startJavaBackend(startOptions({ signal: controller.signal }))).rejects.toThrow(
      "启动已取消",
    );
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});

describe("Spring Boot health readiness", () => {
  it("accepts JSON status UP without following redirects", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"status":"UP"}'));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      waitForSpringHealth("http://127.0.0.1:8080", { timeoutMs: 1000 }),
    ).resolves.toEqual({ ready: true, error: null });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/actuator/health");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries until the health endpoint reports UP", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValue(new Response('{"status":"UP"}'));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      waitForSpringHealth("http://127.0.0.1:8080", { timeoutMs: 2000 }),
    ).resolves.toEqual({ ready: true, error: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a JSON health response that is not UP", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response('{"status":"DOWN"}')));
    vi.stubGlobal("fetch", fetchMock);
    await expect(waitForSpringHealth("http://127.0.0.1:8080", { timeoutMs: 20 })).resolves.toEqual({
      ready: false,
      error: "Spring Boot 健康检查状态不是 UP",
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("rejects a non-JSON health response without echoing its body", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response("<html>temporarily unavailable secret-body</html>")),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await waitForSpringHealth("http://127.0.0.1:8080", { timeoutMs: 20 });
    expect(result.ready).toBe(false);
    expect(result.error).toBe("Spring Boot 健康检查响应不是 JSON");
    expect(result.error).not.toContain("secret-body");
  });

  it("reports a fixed message for HTTP failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(() => Promise.resolve(new Response("hidden-body", { status: 503 }))),
    );
    await expect(waitForSpringHealth("http://127.0.0.1:8080", { timeoutMs: 20 })).resolves.toEqual({
      ready: false,
      error: "Spring Boot 健康检查返回 HTTP 503",
    });
  });

  it("times out with a fixed message and no raw error text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED raw-secret")));
    const result = await waitForSpringHealth("http://127.0.0.1:8080", { timeoutMs: 10 });
    expect(result).toEqual({ ready: false, error: "Spring Boot 健康检查超时" });
    expect(result.error).not.toContain("ECONNREFUSED");
    expect(result.error).not.toContain("raw-secret");
  });

  it("returns cancelled before requesting when the predicate cancels", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      waitForSpringHealth("http://127.0.0.1:8080", { timeoutMs: 1000, cancelled: () => true }),
    ).resolves.toEqual({ ready: false, error: "cancelled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns cancelled for an already-aborted signal", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      waitForSpringHealth("http://127.0.0.1:8080", {
        timeoutMs: 1000,
        signal: AbortSignal.abort(),
      }),
    ).resolves.toEqual({ ready: false, error: "cancelled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels an in-flight request when the signal aborts", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );
    const pending = waitForSpringHealth("http://127.0.0.1:8080", {
      timeoutMs: 5000,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(pending).resolves.toEqual({ ready: false, error: "cancelled" });
  });
});
