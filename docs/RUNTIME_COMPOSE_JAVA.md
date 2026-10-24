# 运行环境：容器分组与 compose / Spring Boot 托管

## 1. Docker 列表按项目分组

工作台创建的 Python 运行栈容器、网络、卷现在额外写入分组标签（仅用于显示）：

- `com.docker.compose.project = gs-python-<项目哈希前 8 位>`
- `com.docker.compose.service = <角色>`

Docker Desktop 据此把一个项目的 6 个容器折叠成一组。归属判定仍只看 `io.graduatestudio.python-runtime*` 标签，外部 compose 项目无法冒充这些资源。实测：`gs-python-ed52295bec18f0da5b5c5f4c-backend` 现在带 `gs-python-ed52295b` 分组。

## 2. 托管项目自带的 docker-compose

新增 `src/server/runtime/project-compose.ts`：

- 只识别项目根目录 `docker-compose.yml/.yaml`、`compose.yml/.yaml`（普通文件、非符号链接、≤128KiB）。
- compose 项目名固定 `gs-<projectId 前 8 位>`，与项目自带 compose 既有命名一致。
- 启动前探测宿主机端口占用；若 compose 里 `${DB_PORT:-3306}` 之类的默认端口被占用，则分配新端口，并通过 `--env-file`（0600 临时文件、finally 删除）注入，避免 `3306` 与本机 MySQL 冲突。
- up 前后各校验一次 `com.docker.compose.project` 标签，拒绝接管别人的同名项目。
- 服务就绪要求全部 running，有 healthcheck 时必须 healthy；超时固定 120s。
- 停止用 `docker compose down`（不加 `-v`，保留数据卷）；不删镜像、不碰非本项目资源。
- 若 compose 内存在 `api|backend|server|app` 服务并发布了端口，则作为后端地址；否则只当基础设施。

## 3. 托管 Spring Boot 后端

新增 `src/server/runtime/java-backend.ts`：

- 识别 `server/pom.xml` 或 `backend/pom.xml`（需同时含 `spring-boot` 与 `spring-boot-maven-plugin`）。
- 工具链探测 `java -version`；Windows 上 Node 不能直接执行 `.cmd`，因此 `mvn -v` 经 `cmd.exe /d /s /c` 探测（此前的直接 `mvn.cmd` 探测在 Windows 必然失败）。
- 启动 `mvn -B -q spring-boot:run`（Windows 走 `cmd.exe`，POSIX `detached` 便于整组终止），`SERVER_PORT` 由平台注入。
- 健康检查 `GET /actuator/health`，只接受 `{"status":"UP"}`，默认 180s。
- 进程输出只保留末尾 8KiB 用于固定分类（端口占用 / 数据库不可达 / Flyway 失败 / 进程退出），从不打印原文。

## 4. 端口与代理

生成的 Java 项目前端常把代理目标写死（如 `target: 'http://localhost:8080'`），平台的动态端口会让代理落空。因此运行时现在：

1. 读取 `client/vite.config.*` 里的 `target` 端口；
2. 该端口空闲就沿用（本机实测 8080），否则回退分配并在日志明确提示需要改代理或设置 `VITE_DEV_API_TARGET`。

## 5. 优先级

外部显式后端 → 平台原生 Python 栈 → 平台原生 Express 后端 → 项目 compose → Spring Boot。

顺序很重要：电商项目的 compose 需要 `.env` 里的 `SECRET_KEY`，而平台原生 Python 栈已自行注入，若先接管 compose 会直接失败（本轮真实踩到并已修正）。

## 6. 实测

- `project-compose` 28 项、`java-backend` 41 项单测通过；全量 1362 通过、10 跳过。
- 真实端到端：compose 起 MySQL（3306 被占用→自动改端口）→ Spring Boot 启动 → `/actuator/health` UP → 停止时下线容器。
- 工作台一键启动「电商产品营销推广与多平台发布管理系统」：`stack=java`、`/actuator/health` 通过、前端 4470 代理 `/api` 登录返回 200。
- 同一工作台启动电商内容协同平台：仍走 `stack=python`（4424），未被 compose 误接管，健康检查 200。

## 7. 边界

- 只支持项目根目录的 compose 文件；子目录或需要 `-f` 多文件的编排不接管。
- 前端代理端口只解析 `target` 里显式写出的端口；使用相对路径或环境变量拼接的配置需要项目自身支持 `VITE_DEV_API_TARGET`。
- 平台重启后进程表清空，容器不会自动重建，仍需在运行页点一次启动；这是既有行为，本次未改变。
- compose 失败只回固定中文提示，具体原因需看 Docker Desktop 日志。
