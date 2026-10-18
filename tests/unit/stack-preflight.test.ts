import { describe, expect, it } from "vitest";
import { detectSupportedGenerationStack } from "@/lib/stack-preflight";

describe("conservative generation stack preflight", () => {
  it.each([
    "后端：Python FastAPI",
    "Backend: Django",
    "后端采用 Go",
    "backend: ASP.NET",
    "技术栈：PHP",
    "Ruby backend",
    "backend/requirements.txt",
    "server/pyproject.toml",
    "server/MyApp.csproj",
    "backend/go.mod",
  ])("blocks clear unsupported declaration %s", (text) => {
    expect(detectSupportedGenerationStack(text)).toEqual({
      supported: false,
      reason: expect.any(String),
    });
  });
  it.each([
    "",
    "unknown backend",
    "后端使用 Express + Node.js",
    "backend: Java Spring Boot",
    "use Python for data analysis",
    "Backend: Express; Python is used for analytics",
    "不要使用 Python 后端",
    "backend should go fast",
    "前端支持 Python 语法高亮",
  ])("does not guess incompatible stacks from %s", (text) => {
    expect(detectSupportedGenerationStack(text)).toEqual({ supported: true });
  });
});
