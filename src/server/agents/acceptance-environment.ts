import fs from "node:fs/promises";
import path from "node:path";

const TEST_DATABASE_KEYS = new Set([
  "TEST_DB_HOST",
  "TEST_DB_PORT",
  "TEST_DB_USER",
  "TEST_DB_PASSWORD",
  "TEST_DB_NAME",
]);

/** Local connection configuration only: never load commands, NODE_OPTIONS or skip/isolation flags. */
export async function acceptanceTestEnvironment(
  cwd: string,
  inherited: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const result = { ...inherited };
  const root = path.dirname(cwd);
  const file = path.join(root, ".env.test.local");
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw new Error("无法读取本地测试数据库配置 .env.test.local。");
  }
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || stat.isSymbolicLink() || !stat.isFile() || stat.size > 8192)
    throw new Error(".env.test.local 必须是最多 8KiB 的普通文件，不能是符号链接。");
  const text = await fs.readFile(file, "utf8");
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(TEST_DB_[A-Z_]+)\s*=(.*)$/.exec(line);
    if (!match || !TEST_DATABASE_KEYS.has(match[1]))
      throw new Error(".env.test.local 仅允许 TEST_DB_HOST/PORT/USER/PASSWORD/NAME 连接参数。");
    let value = match[2].trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      if (value.length < 2 || value.at(-1) !== value[0])
        throw new Error(".env.test.local 含未闭合引号，请检查配置格式。");
      value = value.slice(1, -1);
    }
    // Explicit process/CI configuration wins. Do not expand variables or interpret content.
    if (result[match[1]] === undefined) result[match[1]] = value;
  }
  if (
    result.TEST_DB_NAME &&
    !/^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*_test(?:_[A-Za-z0-9]+)*$/.test(result.TEST_DB_NAME)
  )
    throw new Error("本地 TEST_DB_NAME 必须带 _test 测试库标记，不能指向业务库。");
  return result;
}
