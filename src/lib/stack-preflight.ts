/** Pure, conservative preflight: unknown requirements are left to generation, never guessed. */
export function detectSupportedGenerationStack(contextText: string): {
  supported: boolean;
  reason?: string;
} {
  const text = contextText.replace(/\r\n/g, "\n");
  const unsupported = [
    {
      name: "Python",
      stack: /\b(?:python|django|flask|fastapi)\b/i,
      manifest:
        /\b(?:backend|server)\/(?:requirements(?:[-\w]*)\.txt|pyproject\.toml|Pipfile|manage\.py)\b/i,
    },
    {
      name: ".NET",
      stack: /(?:\b(?:asp\.?net|dotnet|csharp)\b|\.net\b|C#)/i,
      manifest: /\b(?:backend|server)\/(?:[\w./-]+\.)?(?:csproj|fsproj|sln)\b/i,
    },
    {
      name: "Go",
      stack: /\b(?:go|golang|gin|fiber)\b/i,
      manifest: /\b(?:backend|server)\/go\.mod\b/i,
    },
    { name: "Ruby", stack: /\b(?:ruby|rails)\b/i, manifest: /\b(?:backend|server)\/Gemfile\b/i },
    {
      name: "PHP",
      stack: /\b(?:php|laravel|symfony)\b/i,
      manifest: /\b(?:backend|server)\/composer\.json\b/i,
    },
  ];
  const declarations = text.split("\n").filter((line) => {
    if (/(?:不使用|不要使用|不采用|无需|不需要|not\s+using|do\s+not\s+use|without)/i.test(line))
      return false;
    return /(?:后端|服务端|后台|backend|server[- ]side|技术栈|tech(?:nology)?\s+stack)/i.test(line);
  });
  for (const { name, stack, manifest } of unsupported) {
    const explicitStack = declarations.some((line) => {
      if (!stack.test(line)) return false;
      const token = stack.source;
      return (
        new RegExp(
          `(?:后端|服务端|后台|backend|server[- ]side|技术栈|tech(?:nology)?\\s+stack)\\s*(?:[:：=/-]\\s*|(?:使用|采用|基于|use[sd]?|using|is|in|with|built\\s+with)\\s*)?(?:${token})`,
          "i",
        ).test(line) ||
        new RegExp(`(?:${token})\\s*(?:后端|服务端|后台|backend|server[- ]side)`, "i").test(line)
      );
    });
    if (manifest.test(text) || explicitStack) {
      return {
        supported: false,
        reason: `当前生成与验收仅支持 Java/Maven 或 Node.js 后端；明确声明的 ${name} 后端暂不支持。`,
      };
    }
  }
  return { supported: true };
}
