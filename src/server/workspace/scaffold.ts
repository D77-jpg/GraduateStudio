import { db } from "@/server/db";
import { writeFileContent, fileExists } from "./files";

/**
 * 工作区脚手架:项目首次进入开发工作区且工作区为空时,
 * 根据技术栈确定性生成一组最小可编辑的真实文件(AI 稍后在此基础上开发)。
 * 不使用任何 AI 调用 —— 保持快速、确定、可测试。
 */

interface ScaffoldFile {
  path: string;
  content: string;
}

function renderRequirementMarkdown(requirement: {
  background: string | null;
  goals: string[];
  roles: Array<{ name: string; description: string }>;
  features: Array<{
    name: string;
    description: string;
    children: Array<{ name: string; description: string }>;
  }>;
  flows: Array<{ name: string; steps: string[] }>;
  nonFunctional: string[];
  boundaries: { inScope: string[]; outOfScope: string[] };
  devTasks: Array<{ title: string; description: string }>;
}): string {
  const lines: string[] = ["# 需求分析", ""];
  if (requirement.background) lines.push("## 项目背景", "", requirement.background, "");
  if (requirement.goals.length) {
    lines.push("## 项目目标", "", ...requirement.goals.map((g) => `- ${g}`), "");
  }
  if (requirement.roles.length) {
    lines.push(
      "## 用户角色",
      "",
      ...requirement.roles.map((r) => `- **${r.name}**:${r.description}`),
      "",
    );
  }
  if (requirement.features.length) {
    lines.push("## 功能模块");
    for (const featureModule of requirement.features) {
      lines.push("", `### ${featureModule.name}`);
      for (const child of featureModule.children) {
        lines.push(`- ${child.name}${child.description ? `:${child.description}` : ""}`);
      }
    }
    lines.push("");
  }
  if (requirement.flows.length) {
    lines.push("## 核心业务流程", "");
    for (const flow of requirement.flows) {
      lines.push(`**${flow.name}**`, "", flow.steps.map((s, i) => `${i + 1}. ${s}`).join("\n"), "");
    }
  }
  if (requirement.nonFunctional.length) {
    lines.push("## 非功能需求", "", ...requirement.nonFunctional.map((n) => `- ${n}`), "");
  }
  if (requirement.boundaries.inScope.length || requirement.boundaries.outOfScope.length) {
    lines.push(
      "## 系统边界",
      "",
      "**范围内**",
      ...requirement.boundaries.inScope.map((s) => `- ${s}`),
      "",
      "**范围外**",
      ...requirement.boundaries.outOfScope.map((s) => `- ${s}`),
      "",
    );
  }
  if (requirement.devTasks.length) {
    lines.push(
      "## 开发任务列表",
      "",
      ...requirement.devTasks.map((t, i) => `${i + 1}. ${t.title}`),
      "",
    );
  }
  return lines.join("\n");
}

function frontendFiles(stack: string, projectName: string): ScaffoldFile[] {
  if (/react|next/i.test(stack)) {
    return [
      {
        path: "client/package.json",
        content: JSON.stringify(
          {
            name: "client",
            private: true,
            scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
            dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
            devDependencies: { vite: "^6.0.0" },
          },
          null,
          2,
        ),
      },
      {
        path: "client/src/App.tsx",
        content: `export default function App() {\n  return <main>${projectName}</main>;\n}\n`,
      },
      {
        path: "client/src/main.tsx",
        content:
          "import { createRoot } from 'react-dom/client';\nimport App from './App';\n\ncreateRoot(document.getElementById('root')!).render(<App />);\n",
      },
    ];
  }
  return [
    {
      path: "client/package.json",
      content: JSON.stringify(
        {
          name: "client",
          private: true,
          scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
          dependencies: { vue: "^3.5.0" },
          devDependencies: { vite: "^6.0.0", "@vitejs/plugin-vue": "^6.0.0" },
        },
        null,
        2,
      ),
    },
    {
      path: "client/index.html",
      content: `<!doctype html>\n<html lang="zh-CN">\n  <body>\n    <div id="app"></div>\n    <script type="module" src="/src/main.js"></script>\n  </body>\n</html>\n`,
    },
    {
      path: "client/vite.config.js",
      content:
        "import { defineConfig } from 'vite';\nimport vue from '@vitejs/plugin-vue';\n\nexport default defineConfig({\n  plugins: [vue()],\n});\n",
    },
    {
      path: "client/src/main.js",
      content:
        "import { createApp } from 'vue';\nimport App from './App.vue';\n\ncreateApp(App).mount('#app');\n",
    },
  ];
}

function backendFiles(stack: string, projectName: string): ScaffoldFile[] {
  if (/spring|java/i.test(stack)) {
    return [
      {
        path: "server/pom.xml",
        content: `<?xml version="1.0" encoding="UTF-8"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0">\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>com.example</groupId>\n  <artifactId>server</artifactId>\n  <version>0.0.1-SNAPSHOT</version>\n</project>\n`,
      },
      {
        path: "server/src/main/java/com/example/server/Application.java",
        content: `package com.example.server;\n\nimport org.springframework.boot.SpringApplication;\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\n\n@SpringBootApplication\npublic class Application {\n    public static void main(String[] args) {\n        SpringApplication.run(Application.class, args);\n    }\n}\n`,
      },
    ];
  }
  if (/fastapi|flask|django|python/i.test(stack)) {
    return [
      { path: "server/requirements.txt", content: "fastapi>=0.115\nuvicorn>=0.32\n" },
      {
        path: "server/main.py",
        content: `from fastapi import FastAPI\n\napp = FastAPI(title="${projectName}")\n\n\n@app.get("/api/health")\ndef health():\n    return {"status": "ok"}\n`,
      },
    ];
  }
  if (/node|express|nest/i.test(stack)) {
    return [
      {
        path: "server/package.json",
        content: JSON.stringify(
          {
            name: "server",
            private: true,
            scripts: { dev: "node src/index.js" },
            dependencies: { express: "^5.0.0" },
          },
          null,
          2,
        ),
      },
      {
        path: "server/src/index.js",
        content: `import express from 'express';\n\nconst app = express();\n\napp.get('/api/health', (_req, res) => res.json({ status: 'ok' }));\n\napp.listen(3001, () => console.log('${projectName} server'));\n`,
      },
    ];
  }
  return [];
}

function detectStacks(project: { techStack: string[]; devLanguage: string | null; type: string }): {
  stackText: string;
  hasFrontend: boolean;
  hasBackend: boolean;
  isPythonPrimary: boolean;
} {
  const stackText = [...project.techStack, project.devLanguage ?? "", project.type].join(" ");
  const hasFrontend = /vue|react|next|前端|uni-?app/i.test(stackText);
  const hasBackend = /spring|fastapi|flask|django|node|express|nest|后端|java|python/i.test(
    stackText,
  );
  const isPythonPrimary =
    /python|fastapi|flask|django/i.test(stackText) && !/spring|java/i.test(stackText);
  return { stackText, hasFrontend, hasBackend, isPythonPrimary };
}

export async function ensureWorkspaceScaffolded(
  projectId: string,
  userId: string,
): Promise<{ scaffolded: boolean }> {
  const projectRow = await db.project.findFirst({ where: { id: projectId, userId } });
  if (!projectRow) throw new Error("项目不存在或无权访问");
  const { toProjectDto } = await import("@/server/projects");
  const project = toProjectDto(projectRow);

  const { listFileTree } = await import("./files");
  const existing = listFileTree(projectId, userId);
  if (existing.length > 0) return { scaffolded: false };

  const requirementRow = await db.requirement.findUnique({
    where: { projectId },
    include: {
      features: {
        select: {
          id: true,
          parentId: true,
          name: true,
          description: true,
          priority: true,
          order: true,
        },
      },
    },
  });
  const roles = requirementRow
    ? await db.userRole.findMany({
        where: { requirementId: requirementRow.id },
        orderBy: { order: "asc" },
      })
    : [];

  const { buildFeatureTree } = await import("@/lib/requirements");
  const requirement = {
    background: requirementRow?.background ?? null,
    goals: JSON.parse(requirementRow?.goals ?? "[]") as string[],
    roles: roles.map((r) => ({ name: r.name, description: r.description })),
    features: requirementRow
      ? buildFeatureTree(
          requirementRow.features.map((f) => ({ ...f, priority: f.priority, order: f.order })),
        )
      : [],
    flows: JSON.parse(requirementRow?.businessFlows ?? "[]") as Array<{
      name: string;
      steps: string[];
    }>,
    nonFunctional: JSON.parse(requirementRow?.nonFunctional ?? "[]") as string[],
    boundaries: JSON.parse(requirementRow?.boundaries ?? '{"inScope":[],"outOfScope":[]}') as {
      inScope: string[];
      outOfScope: string[];
    },
    devTasks: JSON.parse(requirementRow?.devTasks ?? "[]") as Array<{
      title: string;
      description: string;
    }>,
  };

  const files: ScaffoldFile[] = [
    {
      path: "README.md",
      content: `# ${project.name}\n\n${project.description ?? ""}\n\n- 类型:${project.type}\n- 技术栈:${project.techStack.join("、") || "未定"}\n${project.devLanguage ? `- 开发语言:${project.devLanguage}\n` : ""}${project.database ? `- 数据库:${project.database}\n` : ""}\n## 快速开始\n\n本工作区由 GraduateStudio 初始化;在右侧 AI 助手中描述功能(例如「实现用户登录」)开始开发。\n`,
    },
    { path: ".gitignore", content: "node_modules/\ndist/\nbuild/\n__pycache__/\n.env\n*.db\n" },
  ];

  if (requirementRow) {
    files.push({ path: "docs/requirements.md", content: renderRequirementMarkdown(requirement) });
  }

  const { stackText, hasFrontend, hasBackend } = detectStacks(project);
  // 前后端都未识别或都识别到时,前端文件始终生成;后端仅在识别到后端技术栈时生成
  if (hasFrontend || !hasBackend) {
    files.push(...frontendFiles(stackText, project.name));
  }
  if (hasBackend) {
    files.push(...backendFiles(stackText, project.name));
  }

  for (const file of files) {
    if (!fileExists(projectId, userId, file.path)) {
      writeFileContent(projectId, userId, file.path, file.content);
    }
  }

  return { scaffolded: true };
}
