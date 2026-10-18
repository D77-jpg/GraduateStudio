import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "@/components/ui/button";

const m = vi.hoisted(() => ({
  api: vi.fn(),
  states: [] as unknown[],
  stateIndex: 0,
  refIndex: 0,
  refs: [] as Array<{ current: unknown }>,
  setters: [] as Array<ReturnType<typeof vi.fn>>,
  effects: [] as Array<() => void | (() => void)>,
}));

// The project uses a Node test environment. Inject polled state without starting
// effects; SSR checks the real markup, and element handlers exercise user actions.
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = m.stateIndex++;
      const setter = vi.fn();
      m.setters[index] = setter;
      return [index < m.states.length ? m.states[index] : initial, setter];
    },
    useRef: (current: unknown) => {
      const index = m.refIndex++;
      return (m.refs[index] ??= { current });
    },
    useEffect: (effect: () => void | (() => void)) => {
      m.effects.push(effect);
    },
    useCallback: (callback: unknown) => callback,
  };
});
vi.mock("@/lib/api-client", () => ({ apiJson: m.api }));

import { RuntimeView } from "@/components/features/runtime/runtime-view";

type RuntimeState = {
  status: string;
  ready?: boolean;
  port: number | null;
  pid: number | null;
  previewUrl: string | null;
  startedAt: number | null;
  uptimeSec: number | null;
  exitCode: number | null;
  building: boolean;
  backend?: {
    managed: boolean;
    target: string;
    pid: number | null;
    status: string;
    ready: boolean;
    error: string | null;
    healthScope: "http" | "services";
    stack?: "python";
    services?: Array<{ name: string; status: string }>;
  } | null;
};

function state(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    status: "running",
    ready: true,
    port: 4311,
    pid: 123,
    previewUrl: "http://localhost:4311",
    startedAt: 1,
    uptimeSec: 10,
    exitCode: null,
    building: false,
    ...overrides,
  };
}

function pythonBackend(): NonNullable<RuntimeState["backend"]> {
  return {
    managed: true,
    stack: "python",
    healthScope: "services",
    target: "http://localhost:8000",
    pid: null,
    status: "running",
    ready: true,
    error: null,
    services: ["mysql", "redis", "backend", "worker", "beat"].map((name) => ({
      name,
      status: "running",
    })),
  };
}

function setState(status: RuntimeState | null, busy: string | null = null) {
  m.stateIndex = 0;
  m.refIndex = 0;
  m.refs = [];
  m.effects = [];
  m.setters = [];
  m.states = [0, [], status, busy, null, "console", null, false];
}

function markup(status: RuntimeState, busy: string | null = null) {
  setState(status, busy);
  return renderToStaticMarkup(createElement(RuntimeView, { projectId: "project" }));
}

type ButtonProps = { children?: ReactNode; disabled?: boolean; onClick?: () => void };
function buttons(node: ReactNode): ButtonProps[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [
    ...(node.type === Button ? [node.props as ButtonProps] : []),
    ...buttons(node.props.children),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  setState(null);
});

describe("runtime full-stack readiness", () => {
  it("shows managed Python service readiness without claiming business acceptance", () => {
    const html = markup(state({ backend: pythonBackend() }));
    expect(html).toContain("全栈 Python 已就绪");
    expect(html).toContain("平台管理");
    for (const name of ["mysql", "redis", "backend", "worker", "beat"]) {
      expect(html).toContain(`${name}：运行中`);
    }
    expect(html).toContain("不代表全部业务验收通过");
    expect(html).not.toContain("仅验证 HTTP 健康");
    expect(m.api).not.toHaveBeenCalled();
  });

  it("keeps legacy Express/external HTTP-only readiness distinct", () => {
    for (const managed of [true, false]) {
      const html = markup(
        state({
          backend: {
            managed,
            target: "http://localhost:3000",
            pid: 321,
            status: "running",
            ready: true,
            error: null,
            healthScope: "http",
          },
        }),
      );
      expect(html).toContain("后端 HTTP：已就绪");
      expect(html).toContain("仅验证 HTTP 健康；不代表数据库和全部业务验收通过");
      expect(html).toContain(managed ? "平台管理" : "外部服务");
      expect(html).not.toContain("全栈 Python 已就绪");
    }
  });

  it("retains the frontend-only warning when no backend is configured", () => {
    const html = markup(state({ backend: null }));
    expect(html).toContain("当前仅前端页面已就绪");
    expect(html).toContain("前端能打开不代表全栈运行或业务验收通过");
  });

  it("shows individual starting, failed and stopped services and backend errors", () => {
    const backend = pythonBackend();
    backend.status = "failed";
    backend.ready = false;
    backend.error = "worker health check failed";
    backend.services = [
      { name: "mysql", status: "running" },
      { name: "redis", status: "starting" },
      { name: "worker", status: "failed" },
      { name: "beat", status: "stopped" },
    ];
    const html = markup(state({ backend }));
    expect(html).toContain("全栈 Python 未就绪");
    expect(html).toContain("redis：启动中");
    expect(html).toContain("worker：运行失败");
    expect(html).toContain("beat：已停止");
    expect(html).toContain(backend.error);
    expect(html).not.toContain("全栈 Python 已就绪");
  });

  it("does not label a contradictory or frontend-unready snapshot as full-stack ready", () => {
    const backend = pythonBackend();
    backend.services![4].status = "failed";
    expect(markup(state({ backend }))).not.toContain("全栈 Python 已就绪");
    expect(markup(state({ backend: pythonBackend(), ready: false }))).not.toContain(
      "全栈 Python 已就绪",
    );
    expect(markup(state({ backend: pythonBackend(), status: "starting" }))).not.toContain(
      "全栈 Python 已就绪",
    );
  });
});

describe("explicit Python preview login", () => {
  it("never requests or displays credentials by default and hides the action for HTTP backends", () => {
    const html = markup(state({ backend: pythonBackend() }));
    expect(html).toContain("查看预览账号");
    expect(html).not.toContain("密码：");
    const backend = pythonBackend();
    delete backend.stack;
    backend.healthScope = "http";
    expect(markup(state({ backend }))).not.toContain("查看预览账号");
    expect(m.api).not.toHaveBeenCalled();
  });

  it("fetches credentials only after a click, with duplicate requests guarded", async () => {
    setState(state({ backend: pythonBackend() }));
    const reveal = buttons(RuntimeView({ projectId: "project" })).find(
      (button) => button.children === "查看预览账号",
    )!;
    m.api.mockResolvedValue({ username: "preview-admin", password: "local-secret" });
    reveal.onClick?.();
    reveal.onClick?.();
    expect(m.api).toHaveBeenCalledTimes(1);
    expect(m.api).toHaveBeenCalledWith("/api/projects/project/runtime?action=preview-login", {
      method: "POST",
    });
    await Promise.resolve();
    expect(m.setters[6]).toHaveBeenCalledWith({
      projectId: "project",
      username: "preview-admin",
      password: "local-secret",
    });
  });

  it("allows explicit hiding and automatically removes credentials after one minute", () => {
    setState(state({ backend: pythonBackend() }));
    m.states[6] = { projectId: "project", username: "preview-admin", password: "local-secret" };
    const tree = RuntimeView({ projectId: "project" });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("用户名：preview-admin");
    expect(html).toContain("密码：local-secret");
    expect(html).toContain("仅供本地开发预览使用");
    buttons(tree)
      .find((button) => button.children === "隐藏预览账号")
      ?.onClick?.();
    expect(m.setters[6]).toHaveBeenCalledWith(null);
    vi.useFakeTimers();
    try {
      const cleanup = m.effects[2]();
      vi.advanceTimersByTime(60_000);
      expect(m.setters[6]).toHaveBeenCalledTimes(2);
      if (typeof cleanup === "function") cleanup();
    } finally {
      vi.useRealTimers();
    }
    expect(m.api).not.toHaveBeenCalled();
  });

  it("never displays credentials associated with a previous project", () => {
    setState(state({ backend: pythonBackend() }));
    m.states[6] = {
      projectId: "other-project",
      username: "private-admin",
      password: "private-secret",
    };
    const html = renderToStaticMarkup(createElement(RuntimeView, { projectId: "project" }));
    expect(html).not.toContain("private-secret");
    expect(html).not.toContain("private-admin");
    expect(html).toContain("查看预览账号");
  });
});

describe("runtime startup controls", () => {
  it.each(["starting", "building"])(
    "disables both Run entries and Restart/Build while %s",
    (status) => {
      setState(state({ status }));
      const controls = buttons(RuntimeView({ projectId: "project" }));
      expect(controls.filter((button) => button.children === "启动/准备环境中…")).toHaveLength(2);
      const nonStop = controls.filter((button) => button.children !== "取消启动");
      for (const button of nonStop) expect(button.disabled).toBe(true);
      expect(controls.find((button) => button.children === "取消启动")?.disabled).toBe(false);
      for (const button of nonStop) button.onClick?.();
      expect(m.api).not.toHaveBeenCalled();
      const html = markup(state({ status }));
      expect(html).toContain("首次可能需要数分钟");
      expect(html).toContain("无需重复点击 Run 或 Restart");
    },
  );

  it("disables restart and build while backend services start even if the frontend is running", () => {
    const backend = pythonBackend();
    backend.status = "starting";
    backend.ready = false;
    backend.services![0].status = "starting";
    setState(state({ backend }));
    const controls = buttons(RuntimeView({ projectId: "project" }));
    expect(controls.find((button) => button.children === "取消启动")?.disabled).toBe(false);
    expect(controls.find((button) => button.children === "Restart")?.disabled).toBe(true);
    expect(controls.find((button) => button.children === "Build")?.disabled).toBe(true);
    expect(markup(state({ backend }))).toContain("全栈 Python 启动中");
  });

  it("provides first-start guidance and guards duplicate clicks before a render", async () => {
    setState(state({ status: "stopped", port: null, previewUrl: null }));
    const controls = buttons(RuntimeView({ projectId: "project" }));
    const run = controls.filter((button) => button.children === "Run");
    expect(run).toHaveLength(2);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    m.api.mockReturnValueOnce(pending).mockResolvedValue({ status: state({ status: "starting" }) });
    run[0].onClick?.();
    run[1].onClick?.();
    expect(m.api).toHaveBeenCalledTimes(1);
    expect(m.api).toHaveBeenCalledWith("/api/projects/project/runtime?action=start", {
      method: "POST",
    });
    finish();
    await pending;
    await Promise.resolve();
    expect(m.api).toHaveBeenCalledTimes(2);
    expect(m.api.mock.calls.every(([url]) => String(url).includes("/runtime"))).toBe(true);
    expect(markup(state({ status: "stopped", port: null }))).toContain("首次启动会准备运行环境");
  });

  it("can cancel an in-flight start and ignores its late response after stop", async () => {
    setState(state({ status: "stopped", port: null }));
    let finishStart!: () => void;
    let finishStop!: () => void;
    const startPending = new Promise<void>((resolve) => {
      finishStart = resolve;
    });
    const stopPending = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    const stopped = state({ status: "stopped", port: null });
    m.api.mockImplementation((url: string) => {
      if (url.endsWith("action=start")) return startPending;
      if (url.endsWith("action=stop")) return stopPending;
      return Promise.resolve({ status: stopped });
    });
    buttons(RuntimeView({ projectId: "project" }))
      .find((button) => button.children === "Run")
      ?.onClick?.();
    // Re-render with pending start state while preserving refs, as React does.
    m.stateIndex = 0;
    m.refIndex = 0;
    m.states[3] = "start";
    const cancel = buttons(RuntimeView({ projectId: "project" })).find(
      (button) => button.children === "取消启动",
    )!;
    expect(cancel.disabled).toBe(false);
    cancel.onClick?.();
    cancel.onClick?.();
    expect(m.api.mock.calls.filter(([url]) => String(url).endsWith("action=stop"))).toHaveLength(1);
    const statusSetter = m.setters[2];
    finishStop();
    await stopPending;
    await Promise.resolve();
    expect(statusSetter).toHaveBeenCalledWith(stopped);
    finishStart();
    await startPending;
    await Promise.resolve();
    expect(statusSetter).toHaveBeenCalledTimes(1);
    expect(m.api).toHaveBeenCalledTimes(3);
  });

  it("disables cancellation itself while stopping but not while restarting", () => {
    setState(state({ status: "starting" }), "restart");
    expect(
      buttons(RuntimeView({ projectId: "project" })).find(
        (button) => button.children === "取消启动",
      )?.disabled,
    ).toBe(false);
    setState(state({ status: "starting" }), "start");
    m.states[8] = true;
    expect(
      buttons(RuntimeView({ projectId: "project" })).find((button) => button.children === "停止中…")
        ?.disabled,
    ).toBe(true);
  });

  it("keeps both Run entries disabled while the initial start request is pending", () => {
    setState(state({ status: "stopped", port: null }), "start");
    const controls = buttons(RuntimeView({ projectId: "project" }));
    const run = controls.filter((button) => button.children === "启动/准备环境中…");
    expect(run).toHaveLength(2);
    for (const button of run) expect(button.disabled).toBe(true);
    expect(m.api).not.toHaveBeenCalled();
  });
});
