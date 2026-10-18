# 断点继续后反复中断：实际诊断与当前修复

## 当前任务的真实停止原因

只读查询任务 cmv3eby3j001yublcqxm80tus：status=failed，checkpoint.phase=blocked，最后错误为“工程验收受阻；后端 Node 测试：真实 MySQL 集成测试环境不可用”。恢复后会再次验收；并非所有“检查步骤已完成”都意味着检查通过。

生成项目根目录 .env 是 Docker 部署配置，DB_HOST=db；Windows 宿主机验收不能解析这个容器服务名。手动命令的 TEST_DB_* 也不会注入已经运行的平台进程。

“仍存在14项”是诊断抽取的失败项，不等于14个独立代码缺陷。旧真实 Node 运行摘要为383测试、250通过、63失败、70取消，不能拿平台自身的Vitest通过证明生成项目通过。

## 本轮平台修复

- src/server/agents/acceptance-environment.ts：Node 后端验收读取生成项目根 .env.test.local。仅允许 TEST_DB_HOST/PORT/USER/PASSWORD/NAME；进程配置优先。不加载命令、NODE_OPTIONS、skip或隔离开关，不展开变量；限制文件大小与符号链接。显式测试库名必须含_test标记。
- src/server/agents/acceptance.ts：在原node --test命令执行前加载上述连接配置；配置无效时受阻，不绕过检查。
- src/server/agents/acceptance-evidence.ts：明确MySQL初始化上下文中的拒绝访问、连接丢失也归为环境阻塞；普通断言文本不因此自动归类。
- src/server/agents/full-project.ts：定向验收也持久化ACCEPTANCE_REPORT，停滞停止前仍可查看实际证据。
- src/components/features/agent/acceptance-report.tsx：验证并保留独立failureEvidence及不完整标记，直接显示受阻原因和下一步，不让失败数量冒充代码缺陷数量。
- src/components/features/agent/agent-tasks-view.tsx：验收报告位于重复开发步骤之前。恢复按钮与验收门槛未放宽。

## 环境操作及纠正

前一轮SQL脚本误改本机与项目容器的root@localhost密码。本轮已恢复为各自原值并实际验证连接；脚本已删除ALTER USER语句。测试仅使用专用账号，已移除前一轮增加的全局CREATE权限。专用账号连接及campus_activity_test_pPID创建/删除实际通过。

生成项目已新增被现有.gitignore忽略的.env.test.local，保持原Docker DB_*不变。该文件包含本地测试凭据，不公开、不提交。未自动恢复任务或发起模型调用。

## 尚未解决：生成测试代码的数据库与资源生命周期缺陷

实际平台执行器的后端测试诊断在60秒后主动取消，不能声称通过。停止了旧挂起进程。静态复核发现：

1. backend/tests/integration/activity-lifecycle.test.js及registration-rules.test.js的after钩子只关闭helper/local/admin池，不关闭生产src/config/database.js池。真实HTTP登录会创建生产池，mysql2默认配置不保证空闲连接自动回收，子进程可持续存活。
2. 两文件把DB_NAME和TEST_DB_NAME都设为逻辑库名；共享helper因二者相同再追加_test，并默认追加_pPID。夹具写campus_activity_test_test_pPID，HTTP应用仍查campus_activity_test，造成不同库。
3. backend/tests/helpers/apiTestContext.js存在相似的物理库对齐与生产池关闭遗漏。
4. 不是helper初始化自等待：initializeTestDatabase显式传pool到ensureRoleSeeds，当前路径不递归await自身初始化。
5. 不连接真实MySQL的activity-api测试也有4个真实断言失败；activity-service夹具的万能Proxy使社团查询错误返回活动行，不能全部归因于数据库环境。

后续需在原断言保留前提下统一HTTP与夹具的物理隔离测试库、关闭应用连接池，真实验证；如修改生成项目的历史已应用文件，必须同步记录人工变更与断点，防止恢复冲突。未在本轮擅自修改这些生成源码。

## 验证与运行状态

- 平台41个测试文件、585个测试通过，实际退出码0。
- TypeScript与ESLint通过，实际退出码0。
- 最终Next.js生产构建通过；仍有middleware弃用及8个动态文件追踪警告，不宣称零警告。
- 现有http://127.0.0.1:4311/api/health返回200。
- 现有进程为next start，不是dev watcher。生产构建成功不代表内存中已加载代码更新；生效须重启原平台进程并刷新页面，未启动替代端口服务器。

本轮完成平台诊断/配置/显示修复；生成项目的完整工程验收仍未通过。
