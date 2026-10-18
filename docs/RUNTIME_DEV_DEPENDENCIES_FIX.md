# 运行预览开发依赖漏装修复

## 真实故障

项目cmv9krh9p0001ub64kc0o8bse，用户Run退出1，ERR_MODULE_NOT_FOUND: @vitejs/plugin-vue。
实际本地node_modules有Vue等runtime依赖，但缺plugin-vue和vite。平台以production运行，旧运行器npm install未显式包含开发依赖；后续补装分支宣称成功、未核验，并按包名补最新版可能修改声明。
隔离工程检查安装了开发依赖且成功构建，不代表本地预览环境依赖已准备。

## 修复

- 统一检查项目本地全部dependencies/devDependencies及本地dev CLI；不借用宿主依赖。
- 缺失时一次完整安装，明确include dev/prod、NODE_ENV development；清理会省略依赖/重定向全局/仅锁文件/干运行的ambient npm配置。
- 保留项目声明版本，save=false，不再npm install -D <包名>补最新版。
- 安装失败或退出0后仍缺包，立即停止启动，不误报成功。
- 前端启动NODE_ENV development。
- 发现Python server但未管理/连接后端时，日志和运行页明确仅前端可预览；不假称API/数据库可用。

## 验证

运行器18项、companion backend7项通过；生产构建通过并发布原4311。通过登录后的原项目Run接口真实启动：status=running、ready=true，端口4424。首页、/src/main.js、/src/App.vue、/src/router/index.js均HTTP200；本地依赖vite6.4.4、plugin-vue6.0.10确认存在。

边界：backend=null，只验证前端HTTP与Vite编译资源，不代表浏览器交互全部通过。Python后端未启动；8000已有服务/api/health返回404，未将其当作本项目后端、未停止或改动该服务。
不调用模型、不执行数据库迁移、不替用户连接其他项目的后端。
