# Codex全项目开发中断恢复修正

目标任务cmvclxgeo009eubuo9etppl37，项目cmvchc9u70003ubuohutvjmur。副本和既有done模块保留，不篡改失败历史或自动接受代码。

## 已定位

首次engine创建16:25:16Z，营销活动模块16:57:40开始，17:01:32报告通用网关错误。旧gateway进程35分钟绝对生命周期，但整项目多模块复用一个engine；时间吻合寿命耗尽，是高置信嫌疑而非已证明的历史退出原因（旧容器已移除、无退出码）。没有证据确定Responses不兼容、密钥失效或上下文过长。

再次尝试在模型开始前被new excluded=client/dist拦住：这是前端构建产物，不是新增秘密文件。原错误把合法输出与.env/db混为一类。

## 修复

- codex-resume-inventory.ts统一恢复及最终excluded检查，精确允许已有扫描排除的根/client/frontend/server/backend的dist/build/.next/coverage真实目录；递归拒符号链接/硬链接/特殊文件，不把构建产物加入提议；未放行任意tmp、secret、db、server/target。
- codex-assets普通文件拒绝硬链接，保持原二进制变更拒绝；baseline不改。
- 每次模块/规划/修复轮复用engine时先dispose旧engine再建新有界broker，不让全项目累计35分钟寿命在后续模块耗尽；独立验收修复本来新建engine，不重复创建。
- 固定安全HTTP/状态分类，auth/rate/context优先，不从原始密钥中误识别502，不随意猜Responses兼容问题。
- gateway不再自动rm，失败后只inspect固定State.Running/ExitCode；false124才报告BROKER_LIFETIME_EXPIRED，其他停止为BROKER_STOPPED。现有dispose继续清理，不输出原始响应正文/密钥/URL。

## 验证

真实任务stage只读检查通过，done=[foundation,design-system,identity-access,product-catalog,admin-operations]5个不变。恢复回归含client/dist、已完成模块不重做、baseline不改、dist不入提议。编排测试验证每轮创建前销毁旧broker及生命周期顺序。

全量1293项通过、10跳过。TypeScript、限定ESLint、生产构建通过；已部署原4311 .next-codex-recovery-v11，原电商预览4424已恢复。正式接口resume返回ok=true，原任务进入coding，随后新step10“营销活动策划与状态管理”进入running，越过原client/dist拦截，从第一个未完成模块继续。此处仅证明已发起并进入恢复执行，不能代表剩余模块已经完成或工程验证已通过。

全量1293项通过、10跳过。一次Windows临时目录锁EBUSY，单独32项重跑和全量均通过；一次usedWorker类型推断错误已修复后再检查，不掩盖失败尝试。
