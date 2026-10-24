import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 端口探测走 node:net,这里用可控的假服务器替代真实监听,
 * 只由 netState.occupied 决定端口是否被占用,测试不触碰真实网络。
 */
const netState = vi.hoisted(() => ({ occupied: new Set<number>(), ephemeral: 49_000 }));

vi.mock("node:net", () => {
  interface FakeServer {
    once(event: string, handler: (...args: unknown[]) => void): FakeServer;
    removeAllListeners(): FakeServer;
    listen(options: { port?: number }, callback?: () => void): FakeServer;
    close(callback?: () => void): FakeServer;
    address(): { port: number; address: string; family: string } | null;
  }
  const createServer = (): FakeServer => {
    let assigned = 0;
    let listening = false;
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    const emit = (event: string, ...args: unknown[]) => {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(...args);
    };
    const server: FakeServer = {
      once(event, handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
        return server;
      },
      removeAllListeners() {
        handlers.clear();
        return server;
      },
      listen(options, callback) {
        const requested = typeof options.port === "number" ? options.port : 0;
        if (requested !== 0 && netState.occupied.has(requested)) {
          queueMicrotask(() =>
            emit("error", Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" })),
          );
          return server;
        }
        assigned = requested === 0 ? netState.ephemeral++ : requested;
        queueMicrotask(() => {
          listening = true;
          emit("listening");
          callback?.();
        });
        return server;
      },
      close(callback) {
        listening = false;
        callback?.();
        return server;
      },
      address() {
        return listening ? { port: assigned, address: "127.0.0.1", family: "IPv4" } : null;
      },
    };
    return server;
  };
  return { createServer };
});

vi.mock("../../src/server/agents/codex-dependency-network", () => ({
  dependencyDocker: vi.fn(),
  withDependencyNetwork: vi.fn(),
}));

import { dependencyDocker } from "../../src/server/agents/codex-dependency-network";
import {
  composeProjectName,
  composeVariableDefaults,
  detectProjectCompose,
  readComposePortVariables,
  startProjectCompose,
  stopProjectCompose,
} from "../../src/server/runtime/project-compose";

const docker = vi.mocked(dependencyDocker);
const projectId = "cmuwb4h6abc123";
const composeName = "gs-cmuwb4h6";
const ownLabel = { "com.docker.compose.project": composeName };
const foreignLabel = { "com.docker.compose.project": "gs-otherapp" };

const BASIC_COMPOSE = [
  "services:",
  "  api:",
  "    image: example/api:latest",
  "    ports:",
  '      - "8081:8080"',
  "  db:",
  "    image: postgres:16",
  "",
].join("\n");

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gs-compose-test-"));
  netState.occupied.clear();
  netState.ephemeral = 49_000;
  docker.mockReset();
  serve();
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

type DockerHandler = (args: string[]) => string | undefined;

/** 按顺序匹配的 docker 假实现;未命中时返回安全默认值。 */
function serve(...handlers: DockerHandler[]): void {
  docker.mockImplementation(async (args: string[]) => {
    for (const handler of handlers) {
      const output = handler(args);
      if (output !== undefined) return output;
    }
    return "";
  });
}

function composeFile(content: string, name = "docker-compose.yml"): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, content);
  return file;
}

function psRow(service: string, port: number, state = "running", health = "healthy") {
  return {
    Service: service,
    Name: `${composeName}-${service}-1`,
    State: state,
    Health: health,
    Ports: `0.0.0.0:${port}->8080/tcp, [::]:${port}->8080/tcp`,
  };
}

const ownershipPs = (ids: string) => (args: string[]) =>
  args[0] === "ps" && args.includes("--all") ? ids : undefined;
const inspectLabels = (labels: Record<string, string>) => (args: string[]) =>
  args[0] === "container" && args[1] === "inspect"
    ? JSON.stringify([{ Config: { Labels: labels } }])
    : undefined;
const composePs = (output: string) => (args: string[]) =>
  args[0] === "compose" && args.includes("ps") ? output : undefined;

function upCall(): string[] {
  return docker.mock.calls.find(([args]) => args.includes("up"))?.[0] ?? [];
}

/** 捕获拒绝原因，避免 `catch` 返回值与成功结果混入同一联合类型。 */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("expected rejection");
    },
    (error: unknown) => error as Error,
  );
}

describe("compose 文件检测", () => {
  it("没有 compose 时 start 返回 null、stop 返回 false，且零 docker 调用", async () => {
    await expect(startProjectCompose({ projectId, projectDir: root })).resolves.toBeNull();
    await expect(stopProjectCompose({ projectId, projectDir: root })).resolves.toBe(false);
    expect(docker).not.toHaveBeenCalled();
  });

  it("只接受项目根目录白名单文件名", () => {
    for (const name of [
      "docker-compose.yml",
      "docker-compose.yaml",
      "compose.yml",
      "compose.yaml",
    ]) {
      const file = composeFile(BASIC_COMPOSE, name);
      expect(detectProjectCompose(root)).toEqual({ file, directory: root });
      fs.rmSync(file);
    }
    for (const name of ["docker-compose.dev.yml", "compose.json", "Dockerfile", "my-compose.yml"]) {
      composeFile(BASIC_COMPOSE, name);
      expect(detectProjectCompose(root)).toBeNull();
      fs.rmSync(path.join(root, name));
    }
    fs.mkdirSync(path.join(root, "deploy"));
    fs.writeFileSync(path.join(root, "deploy", "docker-compose.yml"), BASIC_COMPOSE);
    expect(detectProjectCompose(root)).toBeNull();
  });

  it("多个候选同时存在时优先 docker-compose.yml", () => {
    composeFile(BASIC_COMPOSE, "compose.yaml");
    const preferred = composeFile("services: {}\n", "docker-compose.yml");
    expect(detectProjectCompose(root)?.file).toBe(preferred);
  });

  it("拒绝超大文件和非普通文件", () => {
    const oversized = path.join(root, "docker-compose.yml");
    fs.writeFileSync(oversized, Buffer.alloc(128 * 1024 + 1, "a"));
    expect(detectProjectCompose(root)).toBeNull();
    fs.writeFileSync(oversized, Buffer.alloc(128 * 1024, "a"));
    expect(detectProjectCompose(root)).not.toBeNull();
    fs.rmSync(oversized);
    fs.mkdirSync(oversized);
    expect(detectProjectCompose(root)).toBeNull();
  });

  it("拒绝符号链接形式的 compose（无符号链接权限的平台跳过）", () => {
    const target = path.join(root, "linked-target.txt");
    fs.writeFileSync(target, BASIC_COMPOSE);
    try {
      fs.symlinkSync(target, path.join(root, "docker-compose.yml"), "file");
    } catch {
      // Windows 默认账号缺少创建符号链接的权限，与仓库既有测试的处理方式一致。
      return;
    }
    expect(detectProjectCompose(root)).toBeNull();
  });
});

describe("compose 项目名", () => {
  it("与既有容器 gs-cmuwb4h6 一致，并只接受小写字母数字", () => {
    expect(composeProjectName("cmuwb4h6")).toBe("gs-cmuwb4h6");
    expect(composeProjectName("cmuwb4h6abc123")).toBe("gs-cmuwb4h6");
    expect(() => composeProjectName("CMUWB4H6abc")).toThrow("项目标识无效");
    expect(() => composeProjectName("cmuwb4h-abc")).toThrow("项目标识无效");
    expect(() => composeProjectName("short")).toThrow("项目标识无效");
    expect(() => composeProjectName("")).toThrow("项目标识无效");
  });
});

describe("compose 变量解析", () => {
  it("只从 ports 段解析三种变量语法并去重", () => {
    const text = [
      "services:",
      "  api:",
      "    ports:",
      '      - "${WEB_PORT:-3000}:3000"',
      '      - "$API_PORT:8000"',
      '      - "${METRICS_PORT}:9100"',
      '      - "${WEB_PORT:-3000}:3001"',
      '      - "${LEGACY_PORT-4000}:4000"',
      "    environment:",
      '      - "IGNORED=${SHOULD_NOT_APPEAR}"',
      '      - "DB_PORT=${DB_PORT:-3306}"',
      "  db:",
      "    ports:",
      "    - '${DB_PORT_FORWARD}:5432'",
      "",
    ].join("\n");
    expect(readComposePortVariables(text)).toEqual([
      "WEB_PORT",
      "API_PORT",
      "METRICS_PORT",
      "LEGACY_PORT",
      "DB_PORT_FORWARD",
    ]);
  });

  it("支持行内 flow 列表且最多 32 个变量", () => {
    expect(readComposePortVariables('    ports: ["${INLINE_PORT:-7000}:7000"]\n')).toEqual([
      "INLINE_PORT",
    ]);
    const lines = ["services:", "  api:", "    ports:"];
    for (let index = 0; index < 40; index += 1)
      lines.push('      - "${PORT_' + index + ":-" + (5000 + index) + '}:80"');
    expect(readComposePortVariables(lines.join("\n"))).toHaveLength(32);
  });

  it("composeVariableDefaults 解析 ${VAR:-default} 与 ${VAR-default}", () => {
    const text = [
      "services:",
      "  db:",
      "    environment:",
      '      PASSWORD: "${DB_PASSWORD:-s3cret}"',
      '      NAME: "${DB_NAME-shop}"',
      '      QUOTED: "${QUOTED_VALUE:-"inside"}"',
      '      PLAIN: "$DB_HOST"',
      '      BAD: "${lower_case:-x}"',
      '      EMPTY: "${EMPTY_DEFAULT:-}"',
      "",
    ].join("\n");
    expect(composeVariableDefaults(text)).toEqual({
      DB_PASSWORD: "s3cret",
      DB_NAME: "shop",
      QUOTED_VALUE: "inside",
    });
  });

  it("composeVariableDefaults 截断 256 字符并最多 64 条", () => {
    expect(
      composeVariableDefaults(`A: \${LONG_VALUE:-${"x".repeat(400)}}`).LONG_VALUE,
    ).toHaveLength(256);
    const lines: string[] = [];
    for (let index = 0; index < 70; index += 1)
      lines.push("V" + index + ': "${D_' + index + ":-value" + index + '}"');
    expect(Object.keys(composeVariableDefaults(lines.join("\n")))).toHaveLength(64);
  });
});

describe("startProjectCompose", () => {
  it("按固定参数执行 up 并返回服务与 apiTarget", async () => {
    const file = composeFile(BASIC_COMPOSE);
    serve(
      composePs(
        JSON.stringify([
          psRow("api", 8181),
          { ...psRow("db", 5432, "running", ""), Ports: "0.0.0.0:5432->5432/tcp" },
        ]),
      ),
    );
    const logs: string[] = [];
    const result = await startProjectCompose({
      projectId,
      projectDir: root,
      log: (message) => logs.push(message),
    });
    const call = docker.mock.calls.find(([args]) => args.includes("up"));
    expect(call?.[0]).toEqual([
      "compose",
      "-p",
      composeName,
      "--project-directory",
      root,
      "-f",
      file,
      "up",
      "-d",
      "--remove-orphans",
    ]);
    expect(call?.[2]).toBe(180_000);
    expect(result).toMatchObject({
      project: composeName,
      directory: root,
      file,
      apiTarget: "http://127.0.0.1:8181",
      env: {},
    });
    expect(result?.services).toEqual([
      { name: "api", state: "running", health: "healthy", ports: [8181] },
      { name: "db", state: "running", health: null, ports: [5432] },
    ]);
    // 无同名容器时不额外 inspect，日志只含固定中文进度句。
    expect(docker.mock.calls.some(([args]) => args[0] === "container")).toBe(false);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((message) => message.length > 0 && !message.includes(root))).toBe(true);
  });

  it("端口默认值被占用时重新分配，并把覆盖值传给 compose 与后端 env", async () => {
    const file = composeFile(
      [
        "services:",
        "  api:",
        "    image: example/api:latest",
        "    ports:",
        '      - "${API_PORT:-8081}:8080"',
        "    environment:",
        '      DB_PASSWORD: "${DB_PASSWORD:-localpass}"',
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(root, ".env"), "API_PORT=9999\nDB_USER=localuser\n");
    netState.occupied.add(8081);
    let environmentFile = "";
    let environmentContent = "";
    serve(
      (args) => {
        if (!(args[0] === "compose" && args.includes("up"))) return undefined;
        const index = args.indexOf("--env-file");
        if (index >= 0) {
          environmentFile = args[index + 1];
          environmentContent = fs.readFileSync(environmentFile, "utf8");
        }
        return "";
      },
      composePs(JSON.stringify([psRow("api", 5101)])),
    );
    const allocatePort = vi.fn(async () => 5101);
    const logs: string[] = [];
    const result = await startProjectCompose({
      projectId,
      projectDir: root,
      allocatePort,
      log: (message) => logs.push(message),
    });
    expect(allocatePort).toHaveBeenCalledTimes(1);
    expect(allocatePort).toHaveBeenCalledWith(`compose:${projectId}:API_PORT`);
    expect(result?.env).toEqual({ DB_PASSWORD: "localpass", API_PORT: "5101" });
    expect(upCall().slice(0, 3)).toEqual(["compose", "--env-file", environmentFile]);
    expect(upCall()).toContain(file);
    expect(environmentContent).toContain("API_PORT=5101");
    expect(environmentContent).toContain("DB_USER=localuser");
    expect(environmentContent).not.toContain("API_PORT=9999");
    // 临时环境文件在启动结束后立即删除。
    expect(fs.existsSync(environmentFile)).toBe(false);
    expect(fs.existsSync(path.dirname(environmentFile))).toBe(false);
    expect(logs.every((message) => !message.includes(environmentContent))).toBe(true);
  });

  it("端口重分配 3 轮仍未解决时回固定中文错误", async () => {
    composeFile(
      ["services:", "  api:", "    ports:", '      - "${API_PORT:-8081}:8080"', ""].join("\n"),
    );
    netState.occupied.add(8081);
    netState.occupied.add(7001);
    const allocatePort = vi.fn(async () => 7001);
    await expect(
      startProjectCompose({ projectId, projectDir: root, allocatePort }),
    ).rejects.toThrow("项目声明的端口被占用，无法启动 compose");
    expect(allocatePort).toHaveBeenCalledTimes(3);
    expect(docker.mock.calls.some(([args]) => args.includes("up"))).toBe(false);
  });

  it("up 失败只回固定中文错误，不回显原始输出", async () => {
    composeFile(BASIC_COMPOSE);
    const raw = `failed at C:\\workspace\\secret\\docker-compose.yml token=abc ${"x".repeat(70_000)}`;
    serve((args) => {
      if (args[0] === "compose" && args.includes("up")) throw new Error(raw);
      return undefined;
    });
    const error = await rejection(startProjectCompose({ projectId, projectDir: root }));
    expect(error.message).toBe("compose 服务启动失败");
    expect(error.message).not.toContain("secret");
    expect(error.message).not.toContain("token");
    expect(error.message).not.toContain("docker-compose.yml");
  });

  it("up 输出超限（执行边界报告溢出）同样只回固定错误", async () => {
    composeFile(BASIC_COMPOSE);
    serve((args) => {
      if (args[0] === "compose" && args.includes("up"))
        throw new Error(`compose up output overflow ${"y".repeat(200_000)} C:\\tmp\\leak`);
      return undefined;
    });
    const error = await rejection(startProjectCompose({ projectId, projectDir: root }));
    expect(error.message).toBe("compose 服务启动失败");
    expect(error.message.length).toBeLessThan(64);
  });

  it("解析 NDJSON 形式的 compose ps 输出", async () => {
    composeFile(BASIC_COMPOSE);
    serve(
      composePs(
        [psRow("api", 8181), psRow("db", 5432, "running", "")]
          .map((row) => JSON.stringify(row))
          .join("\n"),
      ),
    );
    const result = await startProjectCompose({ projectId, projectDir: root });
    expect(result?.services).toEqual([
      { name: "api", state: "running", health: "healthy", ports: [8181] },
      { name: "db", state: "running", health: null, ports: [5432] },
    ]);
  });

  it("解析 JSON 数组形式的 compose ps 输出", async () => {
    composeFile(BASIC_COMPOSE);
    serve(composePs(JSON.stringify([psRow("api", 8181), psRow("db", 5432, "running", "")])));
    const result = await startProjectCompose({ projectId, projectDir: root });
    expect(result?.services.map((service) => service.name)).toEqual(["api", "db"]);
  });

  it("忽略 compose ps 输出里的脏行", async () => {
    composeFile(BASIC_COMPOSE);
    serve(
      composePs(
        [
          "not json",
          JSON.stringify(psRow("api", 8181)),
          "}{",
          JSON.stringify(psRow("db", 5432, "running", "")),
        ].join("\r\n"),
      ),
    );
    const result = await startProjectCompose({ projectId, projectDir: root });
    expect(result?.services.map((service) => service.name)).toEqual(["api", "db"]);
  });

  it("等待服务从 starting 变为 running + healthy", async () => {
    vi.useFakeTimers();
    composeFile(BASIC_COMPOSE);
    let polls = 0;
    serve((args) => {
      if (!(args[0] === "compose" && args.includes("ps"))) return undefined;
      polls += 1;
      return polls === 1
        ? JSON.stringify([psRow("api", 8181, "running", "starting")])
        : JSON.stringify([psRow("api", 8181)]);
    });
    const pending = startProjectCompose({ projectId, projectDir: root });
    const assertion = expect(pending).resolves.toMatchObject({
      apiTarget: "http://127.0.0.1:8181",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  it("健康等待超时抛固定错误", async () => {
    vi.useFakeTimers();
    composeFile(BASIC_COMPOSE);
    serve(composePs(JSON.stringify([psRow("api", 8181, "running", "starting")])));
    const pending = startProjectCompose({ projectId, projectDir: root });
    const assertion = expect(pending).rejects.toThrow("compose 服务未在时限内就绪");
    await vi.advanceTimersByTimeAsync(130_000);
    await assertion;
  });

  it("up 之前拒绝接管同名的其他 compose 项目", async () => {
    composeFile(BASIC_COMPOSE);
    serve(ownershipPs("container-a\n"), inspectLabels(foreignLabel));
    await expect(startProjectCompose({ projectId, projectDir: root })).rejects.toThrow(
      "检测到不属于本项目的 compose 资源",
    );
    expect(docker.mock.calls.some(([args]) => args.includes("up"))).toBe(false);
  });

  it("up 之后再校验一次标签，避免启动过程中被劫持", async () => {
    composeFile(BASIC_COMPOSE);
    let inspections = 0;
    serve(ownershipPs("container-a\n"), (args) => {
      if (args[0] !== "container") return undefined;
      inspections += 1;
      return JSON.stringify([{ Config: { Labels: inspections === 1 ? ownLabel : foreignLabel } }]);
    });
    await expect(startProjectCompose({ projectId, projectDir: root })).rejects.toThrow(
      "检测到不属于本项目的 compose 资源",
    );
    expect(inspections).toBe(2);
    expect(docker.mock.calls.filter(([args]) => args.includes("up"))).toHaveLength(1);
  });

  it("没有 api 类服务时 apiTarget 为 null，不猜内部端口", async () => {
    composeFile(BASIC_COMPOSE);
    serve(composePs(JSON.stringify([psRow("worker", 9000)])));
    const result = await startProjectCompose({ projectId, projectDir: root });
    expect(result?.apiTarget).toBeNull();
  });

  it("apiTarget 取第一个匹配服务名（api/backend/server/app）的发布端口", async () => {
    composeFile(BASIC_COMPOSE);
    serve(
      composePs(
        JSON.stringify([psRow("worker", 9000), psRow("backend", 8181), psRow("api", 8282)]),
      ),
    );
    const first = await startProjectCompose({ projectId, projectDir: root });
    expect(first?.apiTarget).toBe("http://127.0.0.1:8181");
    serve(composePs(JSON.stringify([psRow("web", 3000), psRow("app", 3001)])));
    const second = await startProjectCompose({ projectId, projectDir: root });
    expect(second?.apiTarget).toBe("http://127.0.0.1:3001");
  });
});

describe("stopProjectCompose", () => {
  it("执行 down 保留数据卷并返回 true", async () => {
    const file = composeFile(BASIC_COMPOSE);
    serve(ownershipPs("container-a\n"), inspectLabels(ownLabel));
    await expect(stopProjectCompose({ projectId, projectDir: root })).resolves.toBe(true);
    const call = docker.mock.calls.find(([args]) => args.includes("down"));
    expect(call?.[0]).toEqual([
      "compose",
      "-p",
      composeName,
      "--project-directory",
      root,
      "-f",
      file,
      "down",
    ]);
    expect(call?.[2]).toBe(180_000);
    expect(call?.[0]).not.toContain("-v");
    expect(call?.[0]).not.toContain("--volumes");
  });

  it("没有本项目容器时返回 false 且不执行 down", async () => {
    composeFile(BASIC_COMPOSE);
    await expect(stopProjectCompose({ projectId, projectDir: root })).resolves.toBe(false);
    expect(docker.mock.calls.some(([args]) => args.includes("down"))).toBe(false);
  });

  it("接受调用方传入的 file/directory，不再重新检测", async () => {
    const directory = path.join(root, "nested");
    fs.mkdirSync(directory);
    const file = path.join(directory, "compose.yaml");
    fs.writeFileSync(file, BASIC_COMPOSE);
    serve(ownershipPs("container-a\n"), inspectLabels(ownLabel));
    await expect(
      stopProjectCompose({
        projectId,
        projectDir: path.join(root, "missing"),
        file,
        directory,
      }),
    ).resolves.toBe(true);
    const call = docker.mock.calls.find(([args]) => args.includes("down"))?.[0] ?? [];
    expect(call).toContain(file);
    expect(call).toContain(directory);
  });

  it("down 失败只回固定中文错误，不回显原始输出", async () => {
    composeFile(BASIC_COMPOSE);
    serve(ownershipPs("container-a\n"), inspectLabels(ownLabel), (args) => {
      if (args[0] === "compose" && args.includes("down"))
        throw new Error("raw docker output C:\\secret\\path");
      return undefined;
    });
    const error = await rejection(stopProjectCompose({ projectId, projectDir: root }));
    expect(error.message).toBe("compose 服务停止失败");
    expect(error.message).not.toContain("secret");
    expect(error.message).not.toContain("raw docker output");
  });
});
