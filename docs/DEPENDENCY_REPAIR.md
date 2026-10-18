# 生产模式下生成项目依赖缺失修复

实际发现生成client声明vite/vitest/@vitejs/plugin-vue为devDependencies，但本地未安装完整；验收调用到了宿主工程的Vite。生产模式NODE_ENV可导致npm默认省略开发依赖。仅判断node_modules存在和清单未变化并不能证明安装就绪。

改进：安装显式--include=dev，清理大小写环境覆盖并使用NODE_ENV=development；检查本地所有直接runtime/dev依赖及声明的bin，不接受祖先宿主包代替。依赖就绪检查也用于缓存复用，并在安装完成后重新检查。已有修复计划在恢复时先完成依赖准备，不先运行模型。

验收进程设置GS_NO_AUTO_INSTALL=1，阻止现有生成Vue加载器在验收期间自行安装；生命周期钩子仍禁用。

对于当前特定旧断点：必须同时满足依赖缺失报告、验收脚本保护错误、有已应用前缀且无pending变更集，才在恢复时取消未应用计划后缀，保留已应用记录，转为真实验收。不放行修改build脚本，不取消所有保护。其他中断计划照常恢复。

真实生成client验证：显式安装开发依赖新增137包；保持build=“vite build”，GS_NO_AUTO_INSTALL=1时构建成功，实际Vite6.4.4，Vue插件本地解析成功。此结果只证明前端构建，不能宣称前端测试/后端测试或完整交付通过。

修改文件：src/server/agents/dependency-preparation.ts、src/server/agents/full-project.ts、src/server/agents/acceptance.ts，以及依赖/恢复测试。生成client的package-lock.json由npm安装更新；业务源文件及任务状态未被本次手动修改。
