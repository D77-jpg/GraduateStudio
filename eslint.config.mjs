import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettierConfig from "eslint-config-prettier";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // 关闭与 Prettier 冲突的格式类规则,格式交给 prettier。
  prettierConfig,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "node_modules/**",
    ".workspace/**",
    // 生成项目的骨架模板与闸门执行器不是本产品源码，由其各自工具链检查。
    "resources/templates/**",
    "resources/delivery-gate/**",
  ]),
]);

export default eslintConfig;
