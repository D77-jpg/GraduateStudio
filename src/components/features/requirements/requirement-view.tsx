"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiJson } from "@/lib/api-client";
import { requirementDtoSchema, type RequirementDto } from "@/lib/requirements";
import type { ProjectDto } from "@/lib/projects";
import { PageHeader } from "@/components/layout/topbar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { SparklesIcon } from "@/components/icons";
import { RolesSection } from "./roles-section";
import { FeatureTreeSection } from "./feature-tree-section";
import { StringListSection, FlowsSection, TasksSection, SectionCard } from "./requirement-sections";

const SECTION_TITLE = "text-[13px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500";

function ElapsedSeconds() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="tabular-nums">({seconds} 秒)</span>;
}

function GeneratingPanel() {
  return (
    <div className="rounded-2xl border border-zinc-200 p-12 text-center dark:border-zinc-800">
      <span className="mx-auto flex h-11 w-11 animate-pulse items-center justify-center rounded-md bg-violet-600/10 text-violet-600 dark:text-violet-400">
        <SparklesIcon />
      </span>
      <p className="mt-4 font-medium text-zinc-900 dark:text-zinc-100">
        AI 正在分析需求结构 <ElapsedSeconds />
      </p>
      <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
        正在生成用户角色、功能模块、业务流程与非功能需求,通常需要 20-60
        秒;生成完成后会直接保存到数据库。
      </p>
    </div>
  );
}

export function RequirementWorkspace({ project }: { project: ProjectDto }) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["requirement", project.id], [project.id]);

  const { data, isPending } = useQuery({
    queryKey,
    queryFn: () =>
      apiJson<{ requirement: RequirementDto | null }>(`/api/projects/${project.id}/requirement`),
  });

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const applyRequirement = useCallback(
    (payload: { requirement: unknown }) => {
      const requirement = requirementDtoSchema.parse(payload.requirement);
      queryClient.setQueryData(queryKey, { requirement });
      return requirement;
    },
    [queryClient, queryKey],
  );

  async function generateRequirement() {
    setGenerating(true);
    setGenerateError(null);
    try {
      applyRequirement(
        await apiJson<{ requirement: unknown }>(
          `/api/projects/${project.id}/requirement/generate`,
          { method: "POST" },
        ),
      );
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    } catch (error) {
      setGenerateError(error instanceof Error ? error.message : "生成失败,请重试");
    } finally {
      setGenerating(false);
    }
  }

  if (isPending) {
    return (
      <div aria-busy className="space-y-4">
        <Skeleton className="h-40 rounded-lg" />
        <Skeleton className="h-60 rounded-lg" />
      </div>
    );
  }

  const requirement = data?.requirement ?? null;

  // 生成中 / 尚未生成
  if (generating || requirement === null) {
    return (
      <div>
        <PageHeader title="需求分析" description={project.name} />
        {generating ? (
          <div className="mt-8">
            <GeneratingPanel />
          </div>
        ) : (
          <div className="mt-8">
            {generateError ? (
              <div className="mb-4 rounded-md border border-red-200 bg-red-50/60 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/5 dark:text-red-400">
                {generateError}
                <Link href="/settings" className="ml-2 underline underline-offset-4">
                  检查 AI 配置
                </Link>
              </div>
            ) : null}
            <div className="rounded-2xl border border-dashed border-zinc-300 p-12 text-center dark:border-zinc-700">
              <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-md bg-violet-600/10 text-violet-600 dark:text-violet-400">
                <SparklesIcon />
              </span>
              <p className="mt-4 font-medium text-zinc-900 dark:text-zinc-100">
                让 AI 生成结构化需求分析
              </p>
              <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
                AI 将根据项目信息生成用户角色、功能模块与功能树、核心业务流程、非功能需求、
                系统边界和开发任务,全部结构化保存,可随时手动调整。
              </p>
              <Button size="md" className="mt-5" onClick={() => void generateRequirement()}>
                <SparklesIcon className="h-4 w-4" />
                AI 生成需求分析
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="需求分析"
        description={"生成内容已结构化保存,每个板块都可以直接编辑。"}
        actions={
          <ConfirmButton
            variant="secondary"
            size="md"
            confirmLabel="覆盖现有需求?"
            onConfirm={() => void generateRequirement()}
          >
            AI 重新分析
          </ConfirmButton>
        }
      />

      <div className="mt-8 space-y-6">
        <SectionCard title="项目背景与目标">
          <BackgroundGoalsSection
            projectId={project.id}
            requirement={requirement}
            onRequirement={applyRequirement}
          />
        </SectionCard>

        <RolesSection
          projectId={project.id}
          roles={requirement.roles}
          onRequirement={applyRequirement}
        />

        <FeatureTreeSection
          projectId={project.id}
          modules={requirement.features}
          onRequirement={applyRequirement}
        />

        <SectionCard title="核心业务流程">
          <FlowsSection flows={requirement.flows} />
        </SectionCard>

        <SectionCard title="非功能需求">
          <StringListSection
            items={requirement.nonFunctional}
            onChange={(items) =>
              void patchRequirement(project.id, { nonFunctional: items }, applyRequirement)
            }
            addPlaceholder="补充一条非功能需求,如:列表页加载不超过 2 秒"
          />
        </SectionCard>

        <SectionCard title="系统边界">
          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <p className={`mb-2 ${SECTION_TITLE}`}>范围内(In Scope)</p>
              <StringListSection
                items={requirement.boundaries.inScope}
                onChange={(items) =>
                  void patchRequirement(
                    project.id,
                    {
                      boundaries: {
                        inScope: items,
                        outOfScope: requirement.boundaries.outOfScope,
                      },
                    },
                    applyRequirement,
                  )
                }
                addPlaceholder="本次要做的内容"
              />
            </div>
            <div>
              <p className={`mb-2 ${SECTION_TITLE}`}>范围外(Out of Scope)</p>
              <StringListSection
                items={requirement.boundaries.outOfScope}
                onChange={(items) =>
                  void patchRequirement(
                    project.id,
                    {
                      boundaries: {
                        inScope: requirement.boundaries.inScope,
                        outOfScope: items,
                      },
                    },
                    applyRequirement,
                  )
                }
                addPlaceholder="明确不做的内容"
              />
            </div>
          </div>
        </SectionCard>

        <SectionCard title="开发任务列表">
          <TasksSection tasks={requirement.devTasks} />
        </SectionCard>
      </div>
    </div>
  );
}

async function patchRequirement(
  projectId: string,
  body: Record<string, unknown>,
  apply: (payload: { requirement: unknown }) => unknown,
): Promise<void> {
  const payload = await apiJson<{ requirement: unknown }>(
    `/api/projects/${projectId}/requirement`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
  apply(payload);
}

function BackgroundGoalsSection({
  projectId,
  requirement,
  onRequirement,
}: {
  projectId: string;
  requirement: RequirementDto;
  onRequirement: (payload: { requirement: unknown }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(requirement.background ?? "");
  const [error, setError] = useState<string | null>(null);

  async function save() {
    try {
      const payload = await apiJson<{ requirement: unknown }>(
        `/api/projects/${projectId}/requirement`,
        { method: "PATCH", body: JSON.stringify({ background: draft }) },
      );
      onRequirement(payload);
      setEditing(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className={SECTION_TITLE}>项目背景</p>
        {editing ? null : (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            编辑
          </Button>
        )}
      </div>
      {editing ? (
        <div className="mt-2">
          <textarea
            className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm leading-relaxed outline-none focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-500"
            rows={4}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={2000}
          />
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => void save()}>
              保存
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setDraft(requirement.background ?? "");
                setEditing(false);
              }}
            >
              取消
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
          {requirement.background ?? "(尚未填写背景)"}
        </p>
      )}
      {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}

      <div className="mt-6">
        <p className={SECTION_TITLE}>项目目标</p>
        <div className="mt-2">
          <StringListSection
            items={requirement.goals}
            onChange={(items) => void patchRequirement(projectId, { goals: items }, onRequirement)}
            addPlaceholder="补充一条项目目标"
          />
        </div>
      </div>
    </div>
  );
}
