# 毕业设计系统

## 一键启动（推荐，答辩演示用）

```bash
docker compose up -d --build --wait
```

- 前端：http://localhost:5173
- 后端健康检查：http://localhost:8080/api/health
- 演示账号：管理员 `admin / Admin@123`，普通用户 `student / Student@123`

国内网络可设置镜像后再启动：

```bash
MAVEN_MIRROR=https://maven.aliyun.com/repository/public NPM_REGISTRY=https://registry.npmmirror.com docker compose up -d --build --wait
```

停止：`docker compose down`（加 `-v` 会清空数据库）。

## 本地开发

- 后端：`cd server && mvn spring-boot:run`（需要本机 MySQL，或用 `docker compose up -d mysql`，并设置 `DB_HOST=localhost`）
- 前端：`cd client && npm install && npm run dev`（Vite 代理 `/api` 到 `http://localhost:8080`）
- 测试：`cd server && mvn test`；`cd client && npm test`

## 目录

- `server/` Spring Boot 3 后端（Flyway 迁移在 `src/main/resources/db/migration`）
- `client/` Vue 3 前端
- `delivery/contract.json` 交付契约（服务、健康检查、登录方式、演示账号）
- `docs/PROGRESS.md` 各模块开发记录
