# gs-codex-worker-java

基础 worker（`docker/codex-worker`）+ OpenJDK 17 + Maven。

- 用途：Spring Boot 项目的 Codex 模块内循环（`./gs-verify.sh` 里的 `mvn -o test`）。
- 网络：仍然 `--network none`。依赖来自与交付闸门共享的缓存卷 `gs-gate-cache`（挂载到 `/cache`，`GS_M2_REPO=/cache/m2`）。
  交付闸门第一次在线构建骨架时会把模板依赖下载进该卷；之后模型新增的依赖若离线解析失败，由下一次闸门在线解析。
- 未构建本镜像时，平台自动回退基础镜像并在活动日志中提示：模块内无法编译后端，但交付闸门照样会验证。

```bash
docker build -t gs-codex-worker:0.150.1 docker/codex-worker
docker build -t gs-codex-worker-java:0.150.1 docker/codex-worker-java
```

可用 `GS_CODEX_WORKER_IMAGE_JAVA` 覆盖镜像名。
