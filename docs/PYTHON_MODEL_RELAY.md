# 当前电商项目授权模型连接

用户明确确认后启用，仅项目cmv9krh9p0001ub64kc0o8bse到既有workbuddy2api:7863。没有给Codex Worker开放网络，没有修改模型密钥，没有提交任何生成或重试任务。

## 根因及实际修复

模型原base_url=http://localhost:7863/v1；业务任务运行于Docker Worker，localhost是它自身。实际workbuddy2api在其他Docker网络，Windows端7863监听不等于业务容器可达。

增加平台私有授权文件 .runtime/python-model-relays/<项目SHA256>.json，绑定目标container immutable ID及原网络ID。配置不存密钥，已加入.gitignore，不能由生成代码或普通请求自动创建。target替换后fail closed，需重新确认目标身份；不追随同名新容器。

建立项目专用internal网络，只把目标workbuddy2api接入；另一个固定目标TCP中继连接此网与项目原internal网，只转发7863到目标，无代理目的地参数、无外网、无宿主端口、无项目源码/环境密钥挂载，uid10001/只读root/capdrop/资源上限。目标既有网络保留不改，项目代码仍留内部网。

当前模型服务1仅通过受鉴权PATCH修改base_url为 http://gs-python-ed52295bec18f0da5b5c5f4c-model-relay:7863/v1 ，原密钥、provider、model_name不变。

## 验证

真实backend及worker分别TCP connected；不带认证GET /v1/models返回401，证明模型HTTP服务可达。随后仅在原容器内部使用已有密钥GET /v1/models，两个角色均HTTP200并列出53个模型，密钥未输出；无chat/completions请求、无生成模型调用。

额外发现：现有model_name=deepseek-flash没有出现在该服务返回的53个模型列表里。未擅自替换名称；列表不匹配不是已证明生成失败，但必须确认服务接受的实际模型ID后再生成。网络恢复不等于真实生成端到端通过。

## 生命周期

python-stack启动应用容器后ensurePythonModelRelay；停止时先stopPythonModelRelay，删除归属匹配的中继、从专用网络断开固定目标并删除专用网络，不删除目标、原目标网络、业务持久数据或授权文件。平台重启后按授权恢复。无授权文件完全不做Docker中继操作。

已从升级后的4311真实执行start→stop→start：停止时model-relay容器不再运行、workbuddy2api仍运行；重启后backend/worker均重新使用已有密钥GET模型列表HTTP200。商品8、任务11、内容位8、样例64、导出6均保留；正式诊断接口connected/modelCalls0，预览4424 running。

新增src/server/runtime/python-model-relay.ts与测试；集成src/server/runtime/python-stack.ts。全量1220测试通过、10跳过（其中一个Windows不能执行的POSIX权限用例），TypeScript通过，生产构建通过。一次日志重定向构建失败后以前台输出重跑通过，不把失败尝试掩盖为成功。
