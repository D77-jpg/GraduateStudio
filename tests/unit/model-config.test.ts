import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const m = vi.hoisted(() => ({
  api: vi.fn(),
  refresh: vi.fn(),
  confirm: vi.fn(),
  states: [] as unknown[],
  setters: [] as ReturnType<typeof vi.fn>[],
  index: 0,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: m.refresh }) }));
vi.mock("@/lib/api-client", () => ({ apiJson: m.api }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = m.index++;
      const setter = vi.fn();
      m.setters[index] = setter;
      return [index < m.states.length ? m.states[index] : initial, setter];
    },
    useEffect: vi.fn(),
  };
});
import { ModelConfig } from "@/components/features/settings/model-config";

const profiles = [
  {
    id: "official",
    name: "DeepSeek 官方",
    provider: "deepseek",
    model: "deepseek-chat",
    baseURL: "https://api.deepseek.com",
    hasApiKey: true,
  },
  {
    id: "other",
    name: "备用模型",
    provider: "openai",
    model: "gpt-4.1",
    baseURL: "https://api.openai.com/v1",
    hasApiKey: true,
  },
];
function loaded(canEdit = true, selectedId = "official") {
  const selected = profiles.find((profile) => profile.id === selectedId)!;
  m.states = [
    { ...profiles[0], source: "saved", canEdit },
    profiles,
    "official",
    selectedId,
    false,
    selected.name,
    true,
    { provider: selected.provider, model: selected.model, baseURL: selected.baseURL },
    "",
    false,
    0,
    null,
    "",
    "",
  ];
}
function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props.children)];
}
function button(tree: ReactElement, label: string) {
  return elements(tree).find((element) => element.props.children === label)!;
}
beforeEach(() => {
  vi.clearAllMocks();
  m.index = 0;
  m.states = [];
  m.setters = [];
  vi.stubGlobal("window", { confirm: m.confirm });
});

describe("model configuration profiles", () => {
  it("SSR loading performs no configuration or model requests", () => {
    const html = renderToStaticMarkup(createElement(ModelConfig));
    expect(html).toContain("正在加载模型配置");
    expect(m.api).not.toHaveBeenCalled();
  });
  it("renders saved profiles, active status, blank key and explicit actions", () => {
    loaded();
    const html = renderToStaticMarkup(createElement(ModelConfig));
    expect(html).toContain("DeepSeek 官方（正在使用）");
    expect(html).toContain("备用模型");
    expect(html).toContain("使用此配置");
    expect(html).toContain("不会自动启用或发送模型请求");
    expect(html).toContain("https://api.deepseek.com");
    expect(html).not.toContain("https://api.deepseek.com/v1");
    expect(html).toContain('type="password"');
    expect(html).toContain('name="ai-provider-key"');
    expect(html).toContain("不会返回或显示");
    expect(html).toContain("须明确确认后才发送");
    expect(m.api).not.toHaveBeenCalled();
  });
  it("preserves read-only administrator warnings and disabled mutations", () => {
    loaded(false);
    const html = renderToStaticMarkup(createElement(ModelConfig));
    expect(html).toContain("仅平台管理员可修改全局模型配置");
    expect(html).toContain('<fieldset disabled=""');
    expect(m.api).not.toHaveBeenCalled();
  });
  it("selecting a profile clears the key but never activates or sends requests", () => {
    loaded();
    const tree = ModelConfig();
    const select = elements(tree).find(
      (element) => element.props.value === "official" && element.props.onChange,
    )!;
    (select.props.onChange as (event: unknown) => void)({ target: { value: "other" } });
    expect(m.setters[3]).toHaveBeenCalledWith("other");
    expect(m.setters[8]).toHaveBeenCalledWith("");
    expect(m.setters[2]).not.toHaveBeenCalled();
    expect(m.api).not.toHaveBeenCalled();
  });
  it("new profile resets provider, selected id and key without a request", () => {
    loaded();
    const tree = ModelConfig();
    (button(tree, "新增配置").props.onClick as () => void)();
    expect(m.setters[3]).toHaveBeenCalledWith(null);
    expect(m.setters[4]).toHaveBeenCalledWith(true);
    expect(m.setters[7]).toHaveBeenCalledWith({
      provider: "openai",
      model: "",
      baseURL: "https://api.openai.com/v1",
    });
    expect(m.setters[8]).toHaveBeenCalledWith("");
    expect(m.api).not.toHaveBeenCalled();
  });
  it("does not test connections if the explicit cost confirmation is declined", async () => {
    loaded();
    m.confirm.mockReturnValue(false);
    const tree = ModelConfig();
    await (button(tree, "测试连接").props.onClick as () => Promise<void>)();
    expect(m.confirm).toHaveBeenCalledOnce();
    expect(m.confirm.mock.calls[0][0]).toContain("Token 费用");
    expect(m.api).not.toHaveBeenCalled();
  });
  it("saving without activation retains the selected profile and omits its saved key", async () => {
    loaded(true, "other");
    m.states[6] = false;
    m.states[5] = "备用改名";
    m.api.mockResolvedValue({
      config: { ...profiles[0], source: "saved", canEdit: true },
      profiles,
      activeProfileId: "official",
    });
    const tree = ModelConfig();
    const form = elements(tree).find((element) => element.type === "form")!;
    await (form.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault: vi.fn() });
    expect(JSON.parse(m.api.mock.calls[0][1].body)).toEqual({
      provider: "openai",
      model: "gpt-4.1",
      baseURL: "https://api.openai.com/v1",
      profileId: "other",
      name: "备用改名",
      activate: false,
    });
    expect(m.setters[3]).toHaveBeenCalledWith("other");
    expect(m.setters[8]).toHaveBeenCalledWith("");
  });
  it("a new configuration is explicitly created and defaults to save and use", async () => {
    loaded();
    m.states[3] = null;
    m.states[4] = true;
    m.states[8] = "test-only-key";
    m.api.mockResolvedValue({
      config: { ...profiles[0], source: "saved", canEdit: true },
      profiles,
      activeProfileId: "official",
    });
    const tree = ModelConfig();
    const form = elements(tree).find((element) => element.type === "form")!;
    await (form.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault: vi.fn() });
    const body = JSON.parse(m.api.mock.calls[0][1].body);
    expect(body.createNew).toBe(true);
    expect(body.activate).toBe(true);
    expect(body.apiKey).toBe("test-only-key");
    expect(body).not.toHaveProperty("profileId");
  });
  it("accepted connection testing scopes key resolution to the edited profile", async () => {
    loaded(true, "other");
    m.confirm.mockReturnValue(true);
    m.api.mockResolvedValue({ ok: true, durationMs: 12 });
    const tree = ModelConfig();
    await (button(tree, "测试连接").props.onClick as () => Promise<void>)();
    expect(m.api.mock.calls[0][0]).toBe("/api/settings/ai/test");
    expect(JSON.parse(m.api.mock.calls[0][1].body)).toEqual({
      provider: "openai",
      model: "gpt-4.1",
      baseURL: "https://api.openai.com/v1",
      profileId: "other",
    });
    expect(m.refresh).not.toHaveBeenCalled();
  });
  it("deletion requires explicit confirmation before any mutation", async () => {
    loaded();
    m.confirm.mockReturnValue(false);
    const tree = ModelConfig();
    await (button(tree, "删除此配置").props.onClick as () => Promise<void>)();
    expect(m.confirm).toHaveBeenCalledOnce();
    expect(m.api).not.toHaveBeenCalled();
  });
  it("explicit activation sends only action and selected profile id", async () => {
    loaded(true, "other");
    m.api.mockResolvedValue({
      config: { ...profiles[1], source: "saved", canEdit: true },
      profiles,
      activeProfileId: "other",
    });
    const tree = ModelConfig();
    await (button(tree, "使用此配置").props.onClick as () => Promise<void>)();
    expect(m.api).toHaveBeenCalledWith("/api/settings/ai", {
      method: "POST",
      body: JSON.stringify({ action: "activate", profileId: "other" }),
    });
  });
});
