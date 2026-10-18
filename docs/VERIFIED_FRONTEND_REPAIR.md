# 实际验证的前端修复与停止猜测机制

原始npm test实际运行后发现：构建配置测试在jsdom导入esbuild导致TextEncoder跨realm不变量失败；角色匹配测试选择负责人路由但夹具仅student，正确被权限拒绝。

修复仅两项：build-config.test.js选择Node测试环境（无DOM测试）；guard-runtime.test.js角色匹配夹具使用目标路由真实要求角色。原断言、未登录和学生越权断言、业务权限保留。未改test脚本、未新增runner。实际完整测试17文件178用例通过，约10秒。两项改动作为manual已接受变更集记录并追加到断点，避免恢复快照外部修改冲突。

平台此前在生产进程执行Vitest未覆盖NODE_ENV，导致Node内建被浏览器化；验收测试子进程现在NODE_ENV=test。旧日志实际有四个FAIL path [path]套件加载错误，但诊断只识别FAIL path >用例，所以误报failure details unavailable。已修解析器支持套件和共享启动错误；缺断言/明确启动证据时不允许调用模型猜测修复。被test脚本保护拦截且计划明确基于failure details unavailable的旧计划，不继续原样执行未应用后缀，先获取新验收。

后端原始node --test也实际运行：383测试、250通过、63失败，另有被取消/环境阻塞项目。部分MySQL集成测试连接db:3306失败ENOTFOUND，环境必须真实配置，不能跳过测试或替换假数据。明确MySQL环境失败单独blocked，不能让AI不断重写代码。尚未声称后端或全项目完成。

平台验证：38文件549测试通过，TypeScript/ESLint通过。实际前端通过不等于真实数据库/E2E交付通过。
