# AGENTS.md — 项目约定（Codex 每轮自动读取）

本项目最终交给本科生作为毕业设计：必须能 `docker compose up -d --build --wait` 一键启动、能登录演示、能截图写进论文。
平台交付闸门会在干净副本上真实执行：后端 `mvn test`、前端 `npm run build` + `npm test`、compose 启动、健康检查、
计划中的 HTTP/页面冒烟、重启后端后的持久化复查、浏览器截图。**未通过不算完成。**

## 技术栈
Vue 3 + Vite + vue-router（client/） · Spring Boot 3.3 + Spring Data JPA + Flyway（server/，Java 17） · MySQL 8 · nginx 反代 `/api`。

## 后端约定（server/）
- 包结构按业务纵切：`com.graduate.app.<模块>/`，每个模块含 Entity、Repository、Request DTO、Controller（必要时 Service）。参考 `notice/` 示例。
- 所有接口以 `/api` 开头；统一响应 `ApiResponse`：`{"code":0,"message":"ok","data":...}`；业务错误抛 `BusinessException(httpStatus, message)`。
- 鉴权：请求头 `Authorization: Bearer <token>`，由 `AuthInterceptor` 校验；控制器参数用 `@RequestAttribute(AuthInterceptor.CURRENT_USER) User user` 取当前用户；
  角色校验用 `user.requireRole("ADMIN")`（失败返回 403）。新增免登录接口要加到 `WebConfig` 的排除列表。
- 数据库只通过 Flyway 迁移变更：新增 `src/main/resources/db/migration/V{n}__说明.sql`，**不要修改已有迁移**。SQL 需同时兼容 MySQL 8 与 H2（MySQL 模式）：
  用 `BIGINT AUTO_INCREMENT PRIMARY KEY`、`VARCHAR`、`TEXT`、`DATETIME`、`DECIMAL`，避免存储过程与 MySQL 专有函数。
- `spring.jpa.hibernate.ddl-auto=none`；实体时间字段在 `@PrePersist` 中赋值。
- 测试：`src/test/java`，`@SpringBootTest @AutoConfigureMockMvc @ActiveProfiles("test")`（H2 内存库，Flyway 照常执行），
  用 `TestAuth.login(mockMvc, "admin", "Admin@123")` 取令牌。每个模块至少覆盖：成功路径、校验失败、未登录/越权。
- 演示账号由 `DemoDataSeeder` 首次启动创建；新增角色时同步更新 `delivery/contract.json` 的 accounts。

## 前端约定（client/）
- 页面放 `src/views/`，在 `src/router.js` 注册（需要登录的路由 `meta: { requiresAuth: true }`），并在 `src/App.vue` 导航里加入口。
- 请求统一用 `src/api.js` 的 `request(path, { method, body })`，它会带上令牌并解包 `data`；令牌存 `localStorage["token"]`。
- 每个页面要有清晰的中文标题（冒烟检查按页面文本断言），加载失败要显示错误信息而不是空白。
- 页面加载时不得请求返回 4xx/5xx 的接口（浏览器检查会把它当作缺陷）。

## 交付契约
- `delivery/contract.json` 描述服务名/端口/健康检查/登录方式/演示账号/骨架冒烟，平台据此做运行时验收。不要为了“通过”而删除或弱化其中的冒烟。
- `compose.yaml` 中服务必须有 healthcheck；不要依赖 `.env` 文件（用 `${VAR:-默认值}`）。
  healthcheck 里探测本机端口请用 `curl -fsS`，**不要用 busybox `wget`**：容器可能继承宿主 Docker 的 HTTP 代理环境变量，
  busybox wget 不识别 `no_proxy`，会把 `127.0.0.1` 的请求送进代理并拿到 502，服务会被误判为不健康。

## 工作方式
- 先读 `.gs-codex/context.md`（需求/架构/数据库设计）与 `docs/PROGRESS.md`。
- 修改后运行 `./gs-verify.sh`，直到退出码为 0 再结束本轮（开发容器无网络，依赖来自缓存）。
- 完成一个模块后在 `docs/PROGRESS.md` 追加：数据表、接口、页面路由、测试类。
- 不使用 mock/假数据替代真实持久化；不删除测试或放宽断言来“通过”。
