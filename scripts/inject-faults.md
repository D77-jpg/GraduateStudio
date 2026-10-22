# 闸门故障注入清单（验证闸门本身是否可信）

对一个已经通过闸门的项目（例如骨架模板复制出来的目录）逐项注入故障，每次只注入一项，
运行 `pnpm tsx scripts/replay-gate.ts <目录> --tier full`，闸门必须报 failed/blocked，并指出对应检查项。

| # | 注入方式 | 期望失败的检查 |
|---|---|---|
| 1 | `server/src/main/resources/db/migration/V1__init.sql` 把 `notice.title` 改名为 `subject` | `smoke:skeleton:3`（500）或 `server:maven:test` |
| 2 | 删除 `NoticeController` 上的 `@GetMapping("/{id}")` | `smoke:skeleton:4`、`persist:skeleton:4` |
| 3 | `client/src/api.js` 把请求路径前缀改成 `/apis` | `page:skeleton:6/7`（接口 404 / 文本不可见） |
| 4 | 删除 `DemoDataSeeder` 中 admin 账号 | `smoke:skeleton:0`（登录失败） |
| 5 | `NoticeView.vue` 的 `onMounted` 里 `throw new Error("x")` | `page:skeleton:7`（页面异常） |
| 6 | 删除 `AuthAndNoticeApiTests.java` 全部 `@Test` | `server:maven:test` blocked（没有执行任何测试） |
| 7 | `compose.yaml` 去掉 backend 的 healthcheck 并让应用启动失败（错误的 DB 密码） | `runtime:compose-up` |

7 项全部被拦下，才说明 `passed` 有意义。
