# 业务运行网络默认策略修正

## 用户要求与默认行为

毕设工作台生成业务系统应能直接配置本机及外部模型服务，不逐域逐端口向平台人工授权。原策略将开发Codex沙箱的断网约束误用到业务运行环境；本变更纠正这一产品默认。

- Codex开发Worker保持原断网、只写副本、无宿主Docker socket/业务密钥，不改。
- Python业务bootstrap/backend/worker/beat自动加入项目专用noninternal bridge egress网络，支持DNS和普通出站网络。仍连原项目internal数据网；MySQL/Redis不接egress、不发布数据库端口。
- 业务代码可访问外部及本机/私网服务，不再宣称业务代码受强网络沙箱保护；不使用host网络、不增加privileged或宿主挂载。
- 平台注入host.docker.internal:host-gateway以及MODEL_ENDPOINT_HOST_ALIAS=host.docker.internal。业务模型适配层在此显式环境下将localhost/127.x/::1转换为宿主别名，保留端口路径；非容器运行不自动改地址。本机服务仍须允许Docker访问及满足宿主防火墙规则，平台不能保证宿主仅loopback监听的每个服务可达。
- 当前电商text/image模型适配与连接检测共用同一地址规则。连接测试去掉人工端口白名单，支持合法HTTP(S)端口及无key本地服务；保留metadata/linklocal、URL内凭据及携key重定向保护、10秒超时与响应大小上限。
- 连接错误按DNS/拒绝连接/网络不可达/TLS/超时/认证/模型名区分，原始异常和Key不输出。
- Codex每轮生成契约明确业务网络与开发沙箱不同，要求未来生成系统实现相同本机地址语义；提示词契约不等于证明任意未来生成代码一定正确。

## 当前迁移

旧workbuddy2api固定模型中继已通过原受管stop清理，授权JSON改为.disabled保留回退记录。模型服务1恢复普通用户地址http://localhost:7863/v1；密钥和model_name保持不变。DeepSeek服务2配置保持用户值，不擅自替换官方模型名称。

## 已完成验证

平台1227项测试通过、10跳过；ESLint与生产构建通过。Python数据网络仍internal，新增业务egress单独owned标签及bridge/type复核，启动前network connect回归18项通过。前端Vite构建通过。业务模型针对性140项离线测试通过（1个现有TestClient弃用warning）。业务全量测试仍有Windows权限/sh/GBK相关失败，不能宣称业务全量通过。

正式4311已部署.next-runtime-network-v10，4424预览恢复。正式POST接口：服务1 localhost:7863三项passed/509ms，服务2 DeepSeek官方三项passed/262ms；模型名未改动，官方列表实际包含用户所填模型名。真实Celery Worker内对服务1与2也分别三项passed。现场inspect确认backend/worker双网，MySQL/Redis只internal；旧model-relay容器不再存在。数据商品8/任务12/内容8/样例64/导出6保留。

没有生成调用。
