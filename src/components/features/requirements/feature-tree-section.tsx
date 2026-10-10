"use client";

import { useState } from "react";
import { apiJson } from "@/lib/api-client";
import {
  FEATURE_PRIORITIES,
  FEATURE_PRIORITY_LABELS,
  type FeaturePriority,
  type RequirementDto,
} from "@/lib/requirements";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Input, Select } from "@/components/ui/input";
import { SparklesIcon } from "@/components/icons";

type ModuleNode = RequirementDto["features"][number];

interface FeatureFormValue {
  name: string;
  description: string;
  priority: FeaturePriority;
}

function FeatureForm({
  value,
  pending,
  submitLabel,
  onChange,
  onSave,
  onCancel,
}: {
  value: FeatureFormValue;
  pending: boolean;
  submitLabel: string;
  onChange: (value: FeatureFormValue) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-2 rounded-md border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-700 dark:bg-zinc-800/40">
      <Input
        value={value.name}
        placeholder="功能名称,如:商品搜索"
        maxLength={60}
        onChange={(event) => onChange({ ...value, name: event.target.value })}
      />
      <Input
        value={value.description}
        placeholder="功能描述(可选)"
        maxLength={300}
        onChange={(event) => onChange({ ...value, description: event.target.value })}
      />
      <div className="flex items-center gap-2">
        <Select
          className="w-32"
          value={value.priority}
          onChange={(event) =>
            onChange({ ...value, priority: event.target.value as FeaturePriority })
          }
        >
          {FEATURE_PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {FEATURE_PRIORITY_LABELS[priority]}
            </option>
          ))}
        </Select>
        <Button size="sm" disabled={!value.name.trim() || pending} onClick={onSave}>
          {pending ? "保存中…" : submitLabel}
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
}

export function FeatureTreeSection({
  projectId,
  modules,
  onRequirement,
}: {
  projectId: string;
  modules: ModuleNode[];
  onRequirement: (payload: { requirement: unknown }) => void;
}) {
  const [addingFeatureFor, setAddingFeatureFor] = useState<string | null>(null);
  const [addingModule, setAddingModule] = useState(false);
  const [editingChildId, setEditingChildId] = useState<string | null>(null);
  const [formValue, setFormValue] = useState<FeatureFormValue>({
    name: "",
    description: "",
    priority: "should",
  });
  const [pendingId, setPendingId] = useState<string | "module" | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(op: () => Promise<{ requirement: unknown }>, busyId: string | "module") {
    setPendingId(busyId);
    setError(null);
    try {
      onRequirement(await op());
      setAddingFeatureFor(null);
      setAddingModule(false);
      setEditingChildId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败,请重试");
    } finally {
      setPendingId(null);
    }
  }

  function addFeature(parentId: string | null) {
    return run(
      () =>
        apiJson<{ requirement: unknown }>(`/api/projects/${projectId}/features`, {
          method: "POST",
          body: JSON.stringify({ parentId, ...formValue }),
        }),
      parentId ?? "module",
    );
  }

  function updateFeature(featureId: string) {
    return run(
      () =>
        apiJson<{ requirement: unknown }>(`/api/projects/${projectId}/features/${featureId}`, {
          method: "PATCH",
          body: JSON.stringify(formValue),
        }),
      featureId,
    );
  }

  function deleteFeature(featureId: string) {
    return run(
      () =>
        apiJson<{ requirement: unknown }>(`/api/projects/${projectId}/features/${featureId}`, {
          method: "DELETE",
        }),
      featureId,
    );
  }

  async function regenerateModule(moduleId: string) {
    setRegeneratingId(moduleId);
    setError(null);
    try {
      onRequirement(
        await apiJson<{ requirement: unknown }>(
          `/api/projects/${projectId}/requirement/regenerate-module`,
          { method: "POST", body: JSON.stringify({ moduleId }) },
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "AI 重新生成失败");
    } finally {
      setRegeneratingId(null);
    }
  }

  return (
    <div className="rounded-2xl border border-zinc-200 p-6 dark:border-zinc-800">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          功能模块与功能树
          <span className="ml-2 text-xs font-normal text-zinc-400">
            {modules.length} 个模块 ·{" "}
            {modules.reduce((sum, module) => sum + module.children.length, 0)} 个功能点
          </span>
        </h3>
      </div>

      {error ? (
        <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-500/5 dark:text-red-400">
          {error}
        </p>
      ) : null}

      <div className="mt-4 space-y-4">
        {modules.map((module) => (
          <div
            key={module.id}
            className="rounded-md border border-zinc-200 dark:border-zinc-700"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {module.name}
                </span>
                <Badge>{FEATURE_PRIORITY_LABELS[module.priority]}</Badge>
                <span className="text-xs text-zinc-400">{module.children.length} 个功能点</span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={regeneratingId !== null || pendingId !== null}
                  onClick={() => {
                    setFormValue({ name: "", description: "", priority: "should" });
                    setAddingFeatureFor(addingFeatureFor === module.id ? null : module.id);
                  }}
                >
                  + 功能
                </Button>
                <ConfirmButton
                  variant="ghost"
                  size="sm"
                  confirmLabel="覆盖该模块?"
                  disabled={regeneratingId !== null || pendingId !== null}
                  onConfirm={() => void regenerateModule(module.id)}
                >
                  <span className="flex items-center gap-1">
                    <SparklesIcon className="h-3.5 w-3.5" />
                    {regeneratingId === module.id ? "生成中…" : "AI 重新生成"}
                  </span>
                </ConfirmButton>
                <ConfirmButton
                  variant="ghost"
                  size="sm"
                  confirmLabel="删除模块?"
                  disabled={pendingId !== null}
                  onConfirm={() => void deleteFeature(module.id)}
                >
                  删除
                </ConfirmButton>
              </div>
            </div>

            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {module.children.map((child) =>
                editingChildId === child.id ? (
                  <li key={child.id} className="p-3">
                    <FeatureForm
                      value={formValue}
                      pending={pendingId === child.id}
                      submitLabel="保存修改"
                      onChange={setFormValue}
                      onSave={() => void updateFeature(child.id)}
                      onCancel={() => setEditingChildId(null)}
                    />
                  </li>
                ) : (
                  <li
                    key={child.id}
                    className="group flex items-center justify-between gap-4 px-4 py-2.5"
                  >
                    <div className="min-w-0">
                      <span className="text-sm text-zinc-800 dark:text-zinc-200">
                        {child.name}
                      </span>
                      {child.description ? (
                        <span className="ml-2 text-xs text-zinc-400 dark:text-zinc-500">
                          {child.description}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge tone={child.priority === "must" ? "accent" : "neutral"}>
                        {FEATURE_PRIORITY_LABELS[child.priority]}
                      </Badge>
                      <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setFormValue({
                              name: child.name,
                              description: child.description,
                              priority: child.priority,
                            });
                            setEditingChildId(child.id);
                          }}
                        >
                          编辑
                        </Button>
                        <ConfirmButton
                          variant="ghost"
                          size="sm"
                          confirmLabel="删除?"
                          disabled={pendingId !== null}
                          onConfirm={() => void deleteFeature(child.id)}
                        >
                          删除
                        </ConfirmButton>
                      </div>
                    </div>
                  </li>
                ),
              )}
            </ul>

            {addingFeatureFor === module.id ? (
              <div className="p-3">
                <FeatureForm
                  value={formValue}
                  pending={pendingId === module.id}
                  submitLabel="添加功能点"
                  onChange={setFormValue}
                  onSave={() => void addFeature(module.id)}
                  onCancel={() => setAddingFeatureFor(null)}
                />
              </div>
            ) : null}
          </div>
        ))}

        {addingModule ? (
          <FeatureForm
            value={formValue}
            pending={pendingId === "module"}
            submitLabel="添加模块"
            onChange={setFormValue}
            onSave={() => void addFeature(null)}
            onCancel={() => setAddingModule(false)}
          />
        ) : (
          <Button
            variant="secondary"
            size="sm"
            disabled={pendingId !== null}
            onClick={() => {
              setFormValue({ name: "", description: "", priority: "should" });
              setAddingModule(true);
            }}
          >
            + 添加功能模块
          </Button>
        )}
      </div>
    </div>
  );
}
