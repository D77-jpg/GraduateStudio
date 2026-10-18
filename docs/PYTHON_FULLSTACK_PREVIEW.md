# Python 全栈一键预览

## 支持范围

识别 server/ 或 backend/ 下 requirements.txt + app/main.py 的 FastAPI 工厂项目，当前合同为 app.main:create_app、Alembic、app.tasks.celery_app:celery_app，配套 MySQL 8 和 Redis 7。不是任意 Python 仓库或任意 Compose 的通用执行器。不执行项目 Dockerfile，不读取真实 .env，也不会复用平台或其他项目数据库。

## Run 生命周期

1. 项目本地前端依赖核验，显式包含开发依赖。
2. 对后端源码创建不包含 .env、数据库文件、私钥、上传目录、虚拟环境的只读快照。
3. 通过受限 registry TLS 代理下载二进制 wheels；按 requirements 和 worker 镜像身份隔离缓存。应用离线安装，不开放外网。
4. 按项目 ID hash 创建独立且带身份标签的 internal Docker 网络及 MySQL/Redis/上传导出卷。
5. 生成独立开发凭据，仅保存在平台 runtime state。空数据库执行 Alembic 和种子；已有数据库必须与代码迁移 head 一致，不删除数据、不静默升级未知数据库。
6. 启动 FastAPI、Celery Worker、Beat；应用非root、只读根、cap-drop、无宿主服务凭据。固定可信入口 relay 仅转发本项目 backend:8000，将后端 loopback 端口公开给宿主前端代理。
7. 同时注入 VITE_API_PROXY_TARGET 和 VITE_DEV_API_TARGET；确认前后端与数据库、Redis、Worker readiness 后标记运行。
8. 每15秒复查后端服务；异常整体标失败并清理本项目服务。Stop/Restart 包含所有容器及前端进程；保留专用数据卷。

## 界面与账号

展示Python全栈和各组件状态，首次准备可能数分钟，可取消启动。预览管理员随机生成；用户必须在项目运行页显式点击“查看预览账号”，经过登录与项目所有权验证后返回，no-store、不写日志、不放入轮询数据，60秒自动隐藏。

## 验证与边界

已通过真实4311控制API验收：Run返回running，Python backend ready；前端http://localhost:4424/api/health/ready返回ok（MySQL/cache/queue Worker）；显式取预览账号后POST /api/auth/login成功，Bearer GET /api/auth/me成功；Stop返回stopped；Restart后重新登录成功且管理员ID不变，验证专用数据库持久化。最终部署包含wheel marker严格校验，全部回归999项通过、9跳过，相关52项通过，TypeScript及生产构建通过。

尚未运行完整浏览器点击业务验收，也没有调用模型生成或验证所有业务写入流程。

- health/services 不是全部业务验收；beat检查进程存活，Worker检查响应。
- 无外部模型凭据且应用无外网出口，不承诺AI生成可用，也不自动调用付费模型。
- 本机Docker管理员和平台服务进程属于可信边界；Docker管理权限可查看容器环境。
- Windows chmod不等于完整ACL证明，runtime state仍须由平台用户专用目录/系统访问控制保护。
- 前端仍使用现有宿主npm预览方式，但显式剔除继承的数据库、auth和模型凭据；不等同于前端代码已容器沙箱化。
- 当前是单一平台runtime manager进程，生命周期锁为同进程串行；不支持多manager对同项目并发操作。
