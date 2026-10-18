"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiJson } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";

type Provider = "openai" | "anthropic" | "deepseek" | "glm" | "openrouter";
type AiConfig = {
  provider: Provider | null;
  model: string | null;
  baseURL: string | null;
  hasApiKey: boolean;
  source: "saved" | "environment";
  canEdit: boolean;
  configError?: string;
  profiles?: Profile[];
  activeProfileId?: string | null;
};
type Profile = {
  id: string;
  name: string;
  provider: Provider;
  model: string;
  baseURL: string | null;
  hasApiKey: boolean;
};
type ConfigResponse = {
  config: AiConfig;
  profiles?: Profile[];
  activeProfileId?: string | null;
  configError?: string;
};
type Draft = { provider: Provider; model: string; baseURL: string };

const PROVIDERS: Record<Provider, { label: string; baseURL: string; models: string[] }> = {
  openai: {
    label: "OpenAI 兼容",
    baseURL: "https://api.openai.com/v1",
    models: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o"],
  },
  anthropic: {
    label: "Anthropic",
    baseURL: "https://api.anthropic.com/v1",
    models: ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-5"],
  },
  deepseek: {
    label: "DeepSeek",
    baseURL: "https://api.deepseek.com",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  glm: {
    label: "GLM",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4.7", "glm-4.6", "glm-4-flash"],
  },
  openrouter: {
    label: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    models: ["openai/gpt-4.1-mini", "anthropic/claude-sonnet-4.5", "deepseek/deepseek-chat"],
  },
};

function toDraft(config: Pick<AiConfig, "provider" | "model" | "baseURL">): Draft {
  return {
    provider: config.provider ?? "openai",
    model: config.model ?? "",
    baseURL: config.baseURL ?? "",
  };
}

export function ModelConfig() {
  const router = useRouter();
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [name, setName] = useState("");
  const [activateOnSave, setActivateOnSave] = useState(true);
  const [draft, setDraft] = useState<Draft>({ provider: "openai", model: "", baseURL: "" });
  // The API deliberately supplies only hasApiKey. Never populate this field from server data.
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busy, setBusy] = useState<"save" | "test" | "reset" | "activate" | "delete" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    apiJson<ConfigResponse>("/api/settings/ai", { cache: "no-store", signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        applyResponse(result);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "无法加载模型配置，请稍后重试。");
        setLoading(false);
      });
    return () => controller.abort();
  }, [loadAttempt]);

  function applyResponse(result: ConfigResponse, preferredId?: string | null) {
    const nextProfiles = result.profiles ?? result.config.profiles ?? [];
    const activeId = result.activeProfileId ?? result.config.activeProfileId ?? null;
    const selectedId = preferredId === undefined ? activeId : preferredId;
    const selected = nextProfiles.find((profile) => profile.id === selectedId);
    setConfig({ ...result.config, configError: result.config.configError ?? result.configError });
    setProfiles(nextProfiles);
    setActiveProfileId(activeId);
    setSelectedProfileId(selected?.id ?? null);
    setCreatingNew(false);
    setName(selected?.name ?? "");
    setDraft(toDraft(selected ?? result.config));
    setApiKey("");
  }

  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId);
  const baseline = selectedProfile ? toDraft(selectedProfile) : config ? toDraft(config) : null;
  const dirty = Boolean(
    creatingNew ||
    (baseline &&
      (name !== (selectedProfile?.name ?? "") ||
        draft.provider !== baseline.provider ||
        draft.model !== baseline.model ||
        draft.baseURL !== baseline.baseURL ||
        apiKey.length > 0)),
  );
  const disabled = loading || busy !== null || !config?.canEdit;
  const provider = PROVIDERS[draft.provider];

  function updateDraft(change: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...change }));
    setError("");
    setNotice("");
  }

  function payload() {
    return {
      provider: draft.provider,
      model: draft.model.trim(),
      baseURL: draft.baseURL.trim(),
      ...(selectedProfileId ? { profileId: selectedProfileId } : {}),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    };
  }

  function validate() {
    if (!draft.model.trim()) {
      setError("请填写模型名称。");
      return false;
    }
    if (draft.baseURL.trim()) {
      try {
        const url = new URL(draft.baseURL.trim());
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
          throw new Error("invalid URL");
        }
      } catch {
        setError("请填写有效的 HTTP / HTTPS API 地址，地址中不要包含密钥或账号密码。");
        return false;
      }
    }
    return true;
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || !validate()) return;
    setBusy("save");
    setError("");
    setNotice("");
    try {
      const result = await apiJson<ConfigResponse>("/api/settings/ai", {
        method: "POST",
        body: JSON.stringify({
          ...payload(),
          name: name.trim() || `${provider.label} · ${draft.model.trim()}`,
          activate: activateOnSave,
          ...(creatingNew || !selectedProfileId ? { createNew: true } : {}),
        }),
      });
      const nextProfiles = result.profiles ?? result.config.profiles ?? [];
      const savedId =
        selectedProfileId ??
        nextProfiles.find((profile) => !profiles.some((previous) => previous.id === profile.id))
          ?.id;
      applyResponse(result, savedId);
      setNotice(
        activateOnSave
          ? "配置已保存并启用，后续 AI 请求将使用此配置。"
          : "配置已保存，当前使用的配置未切换。",
      );
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败，请稍后重试。");
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    if (disabled || !validate()) return;
    if (
      !window.confirm(
        "测试连接将向当前填写的模型发送一次小量请求，可能产生少量 Token 费用。测试不会保存配置，是否继续？",
      )
    )
      return;
    setBusy("test");
    setError("");
    setNotice("");
    try {
      const result = await apiJson<{ ok: true; durationMs: number }>("/api/settings/ai/test", {
        method: "POST",
        body: JSON.stringify(payload()),
      });
      setNotice(
        `连接测试成功，用时 ${result.durationMs} 毫秒。${dirty ? "当前修改尚未保存。" : "测试未更改已保存配置。"}`,
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "连接测试失败，请检查地址、模型名称及服务商权限。",
      );
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    if (disabled) return;
    if (
      !window.confirm(
        "确定恢复环境配置？这将删除平台保存的模型配置，并丢弃当前未保存的修改。后续 AI 请求将重新使用服务器环境配置。",
      )
    )
      return;
    setBusy("reset");
    setError("");
    setNotice("");
    try {
      const result = await apiJson<ConfigResponse>("/api/settings/ai", { method: "DELETE" });
      applyResponse(result);
      setNotice("已恢复环境配置，API 密钥输入已清空。");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "恢复失败，请稍后重试。");
    } finally {
      setBusy(null);
    }
  }

  function selectProfile(id: string) {
    if (dirty && !window.confirm("切换编辑配置将丢弃未保存的修改，是否继续？")) return;
    const selected = profiles.find((profile) => profile.id === id);
    setSelectedProfileId(selected?.id ?? null);
    setCreatingNew(false);
    setName(selected?.name ?? "");
    setDraft(toDraft(selected ?? config!));
    setApiKey("");
    setActivateOnSave(true);
    setError("");
    setNotice("");
  }

  function addProfile() {
    if (dirty && !window.confirm("新增配置将丢弃未保存的修改，是否继续？")) return;
    setSelectedProfileId(null);
    setCreatingNew(true);
    setName("");
    setDraft({ provider: "openai", model: "", baseURL: PROVIDERS.openai.baseURL });
    setApiKey("");
    setActivateOnSave(true);
    setError("");
    setNotice("正在新增配置。保存前不会切换当前使用的配置。");
  }

  async function profileAction(action: "activate" | "delete") {
    if (disabled || !selectedProfileId) return;
    if (action === "activate" && dirty) {
      setError("请先保存或放弃编辑中的修改，再使用此配置。");
      return;
    }
    if (
      action === "delete" &&
      !window.confirm(
        "确定删除此配置？已保存的密钥也将删除，且当前未保存的修改会丢弃。若删除正在使用的配置，平台将恢复环境配置。",
      )
    )
      return;
    setBusy(action);
    setError("");
    setNotice("");
    try {
      const result = await apiJson<ConfigResponse>("/api/settings/ai", {
        method: "POST",
        body: JSON.stringify({ action, profileId: selectedProfileId }),
      });
      applyResponse(result, action === "activate" ? selectedProfileId : undefined);
      setNotice(
        action === "activate"
          ? "已切换为此配置，后续 AI 请求将使用此配置。"
          : "配置已删除，API 密钥输入已清空。",
      );
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "配置操作失败，请稍后重试。");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      aria-labelledby="model-config-title"
      className="rounded-2xl border border-zinc-200 bg-white px-6 py-5 dark:border-zinc-800 dark:bg-zinc-900/40"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="model-config-title"
            className="text-base font-semibold text-zinc-900 dark:text-zinc-100"
          >
            模型配置
          </h2>
          <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
            为选题、分析与创作配置 AI 服务。可保存多个服务商配置，平台仅使用当前启用的配置。
          </p>
        </div>
        {config && (
          <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            {config.source === "saved" ? "已保存配置" : "环境配置"}
          </span>
        )}
      </div>

      {config?.configError && (
        <p
          role="alert"
          className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300"
        >
          {config.configError === "config_unavailable"
            ? "已保存的模型配置暂时无法读取。"
            : config.configError}{" "}
          当前显示的参考配置不代表已保存配置可用。
          {config.canEdit
            ? " 请使用「恢复环境配置」清除异常配置，或填写新配置后保存。"
            : " 请联系平台管理员恢复配置。"}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-6 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm leading-6 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300"
        >
          {notice}
        </p>
      )}

      {loading ? (
        <p role="status" className="mt-6 text-sm text-zinc-500">
          正在加载模型配置…
        </p>
      ) : !config ? (
        <Button
          type="button"
          variant="secondary"
          className="mt-4"
          onClick={() => {
            setLoading(true);
            setError("");
            setLoadAttempt((attempt) => attempt + 1);
          }}
        >
          重新加载
        </Button>
      ) : (
        <form onSubmit={save} className="mt-6">
          {!config.canEdit && (
            <p className="mb-5 rounded-xl bg-zinc-50 px-4 py-3 text-sm leading-6 text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400">
              当前配置为只读。仅平台管理员可修改全局模型配置；如需调整，请联系管理员。
            </p>
          )}
          <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-300">
            当前使用：
            {profiles.find((profile) => profile.id === activeProfileId)?.name ??
              (config.source === "environment" ? "环境配置" : "已保存配置")}
            {config.model ? ` · ${config.model}` : ""}
          </p>
          <div className="mb-5 flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1">
              <Field
                label="编辑已保存的配置"
                hint="选择仅切换编辑内容，不会自动启用或发送模型请求。"
              >
                <Select
                  value={creatingNew ? "__new__" : (selectedProfileId ?? "")}
                  disabled={loading || busy !== null}
                  onChange={(event) => selectProfile(event.target.value)}
                >
                  <option value="">环境配置（参考）</option>
                  {creatingNew && <option value="__new__">新增配置（未保存）</option>}
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                      {profile.id === activeProfileId ? "（正在使用）" : ""}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Button type="button" variant="secondary" disabled={disabled} onClick={addProfile}>
              新增配置
            </Button>
          </div>
          <fieldset disabled={disabled} className="space-y-5">
            <Field label="配置名称" hint="为不同服务商、模型或账号设置便于识别的名称。">
              <Input
                value={name}
                maxLength={100}
                placeholder="例如：DeepSeek 官方"
                onChange={(event) => {
                  setName(event.target.value);
                  setError("");
                  setNotice("");
                }}
              />
            </Field>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="服务商">
                <Select
                  value={draft.provider}
                  onChange={(event) => {
                    const next = event.target.value as Provider;
                    updateDraft({ provider: next, baseURL: PROVIDERS[next].baseURL, model: "" });
                    setApiKey("");
                  }}
                >
                  {(Object.keys(PROVIDERS) as Provider[]).map((key) => (
                    <option key={key} value={key}>
                      {PROVIDERS[key].label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="模型名称 *"
                hint="可手动输入。下拉内容仅为示例，不是实时获取的模型列表。"
              >
                <Input
                  required
                  value={draft.model}
                  list="ai-model-suggestions"
                  placeholder={provider.models[0]}
                  onChange={(event) => updateDraft({ model: event.target.value })}
                  autoComplete="off"
                />
                <datalist id="ai-model-suggestions">
                  {provider.models.map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
              </Field>
            </div>
            <Field label="API Base URL" hint={`留空使用服务商默认地址。建议：${provider.baseURL}`}>
              <Input
                type="url"
                value={draft.baseURL}
                placeholder={provider.baseURL}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => updateDraft({ baseURL: event.target.value })}
              />
            </Field>
            <Field
              label="API 密钥"
              hint={
                !creatingNew &&
                (selectedProfile ?? config).hasApiKey &&
                (selectedProfile ?? config).provider === draft.provider
                  ? "此配置已保存密钥（不会返回或显示）。留空保留此配置密钥；输入新密钥后保存可替换。"
                  : "请输入此配置的密钥，或留空使用服务器环境密钥；不会复用其他已保存配置的密钥。"
              }
            >
              <Input
                type="password"
                name="ai-provider-key"
                value={apiKey}
                placeholder="输入新密钥（不显示已有密钥）"
                autoComplete="new-password"
                spellCheck={false}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setError("");
                  setNotice("");
                }}
              />
            </Field>
            <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
              <input
                type="checkbox"
                checked={activateOnSave}
                onChange={(event) => setActivateOnSave(event.target.checked)}
              />
              保存后使用此配置（取消勾选则仅保存，不切换）
            </label>
          </fieldset>
          <p className="mt-5 rounded-xl bg-zinc-50 px-4 py-3 text-xs leading-5 text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400">
            测试连接使用当前填写的配置，不会自动保存；会发送一次小量模型请求，可能产生少量 Token
            费用，须明确确认后才发送。仅平台管理员可修改；密钥不会由接口返回。运行中的 AI
            任务结束前，平台暂不允许保存、切换、删除或恢复配置。
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-zinc-100 pt-5 dark:border-zinc-800">
            <Button
              type="submit"
              disabled={
                disabled || (!dirty && !(activateOnSave && selectedProfileId !== activeProfileId))
              }
            >
              {busy === "save" ? "正在保存…" : activateOnSave ? "保存并使用" : "仅保存配置"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={
                disabled || !selectedProfileId || selectedProfileId === activeProfileId || dirty
              }
              onClick={() => profileAction("activate")}
            >
              {busy === "activate" ? "正在切换…" : "使用此配置"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={disabled || !selectedProfileId}
              onClick={() => profileAction("delete")}
            >
              {busy === "delete" ? "正在删除…" : "删除此配置"}
            </Button>
            <Button type="button" variant="secondary" disabled={disabled} onClick={test}>
              {busy === "test" ? "正在测试…" : "测试连接"}
            </Button>
            <Button type="button" variant="ghost" disabled={disabled} onClick={reset}>
              {busy === "reset" ? "正在恢复…" : "恢复环境配置"}
            </Button>
            {dirty && (
              <span className="text-xs text-amber-600 dark:text-amber-400">有未保存的修改</span>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
