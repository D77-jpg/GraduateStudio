"use client";

import { useState } from "react";
import { apiJson } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Input } from "@/components/ui/input";

/** 用户角色:列表编辑(增/改/删),通过 PATCH requirement 整体保存。 */

interface RoleDraft {
  name: string;
  description: string;
}

export function RolesSection({
  projectId,
  roles,
  onRequirement,
}: {
  projectId: string;
  roles: Array<{ name: string; description: string }>;
  onRequirement: (payload: { requirement: unknown }) => void;
}) {
  const [editingIndex, setEditingIndex] = useState<number | "new" | null>(null);
  const [draft, setDraft] = useState<RoleDraft>({ name: "", description: "" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveRoles(nextRoles: Array<{ name: string; description: string }>) {
    setPending(true);
    setError(null);
    try {
      const payload = await apiJson<{ requirement: unknown }>(
        `/api/projects/${projectId}/requirement`,
        { method: "PATCH", body: JSON.stringify({ roles: nextRoles }) },
      );
      onRequirement(payload);
      setEditingIndex(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setPending(false);
    }
  }

  function openEdit(index: number) {
    setDraft(roles[index]);
    setEditingIndex(index);
  }

  return (
    <div className="rounded-2xl border border-zinc-200 p-6 dark:border-zinc-800">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          用户角色
          <span className="ml-2 text-xs font-normal text-zinc-400">{roles.length} 个</span>
        </h3>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => {
            setDraft({ name: "", description: "" });
            setEditingIndex("new");
          }}
        >
          + 添加角色
        </Button>
      </div>

      {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}

      <ul className="mt-3 divide-y divide-zinc-100 dark:divide-zinc-800">
        {roles.map((role, index) =>
          editingIndex === index ? (
            <li key={index} className="py-3">
              <RoleForm
                draft={draft}
                pending={pending}
                onChange={setDraft}
                onCancel={() => setEditingIndex(null)}
                onSave={() => void saveRoles(roles.map((item, i) => (i === index ? draft : item)))}
              />
            </li>
          ) : (
            <li key={index} className="group flex items-start justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {role.name}
                </p>
                {role.description ? (
                  <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
                    {role.description}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                <Button variant="ghost" size="sm" onClick={() => openEdit(index)}>
                  编辑
                </Button>
                <ConfirmButton
                  variant="ghost"
                  size="sm"
                  confirmLabel="删除?"
                  onConfirm={() => void saveRoles(roles.filter((_, i) => i !== index))}
                >
                  删除
                </ConfirmButton>
              </div>
            </li>
          ),
        )}

        {editingIndex === "new" ? (
          <li className="py-3">
            <RoleForm
              draft={draft}
              pending={pending}
              onChange={setDraft}
              onCancel={() => setEditingIndex(null)}
              onSave={() => void saveRoles([...roles, draft])}
            />
          </li>
        ) : null}

        {roles.length === 0 && editingIndex !== "new" ? (
          <li className="py-6 text-center text-sm text-zinc-400">
            暂无角色,点击「添加角色」创建
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function RoleForm({
  draft,
  pending,
  onChange,
  onSave,
  onCancel,
}: {
  draft: RoleDraft;
  pending: boolean;
  onChange: (draft: RoleDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const valid = draft.name.trim().length > 0;
  return (
    <div className="space-y-2">
      <Input
        value={draft.name}
        placeholder="角色名称,如:学生用户"
        maxLength={40}
        onChange={(event) => onChange({ ...draft, name: event.target.value })}
      />
      <Input
        value={draft.description}
        placeholder="角色职责描述(可选)"
        maxLength={300}
        onChange={(event) => onChange({ ...draft, description: event.target.value })}
      />
      <div className="flex gap-2">
        <Button size="sm" disabled={!valid || pending} onClick={onSave}>
          {pending ? "保存中…" : "保存"}
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
}
