# 选题化 UI 设计能力接入

## 已接入范围

接入平台实际 Codex 隔离开发路径 executeCodexTask / createIsolatedCodexEngine，不是宿主全局安装。平台固定 resources/design-skills，创建Worker之前核验所有文件SHA256、完整文件集合、常规非链接文件和大小上限，只读挂载 /opt/gs-design-skills。每轮明确读取资源和项目设计规范，不依赖临时HOME自动发现。

- UI UX Pro Max commit 56ea9cf174ed86786187daa9de0e6247cb0747e4，MIT。
- Anthropic frontend-design commit dbd4588f9e1033efb41dad4bef2f7947c8993d44，Apache-2.0。
- 上游许可证保留，UI skill入口作本地路径适配并标注，资源来源逐项记录 provenance.json。
- 不运行上游安装器，不全局装npm，不改变已有Worker镜像tag，也不增加联网、权限、MCP或宿主HOME访问。

## 编排合同

完整开发与明确UI设计/美化任务增加设计前置；局部后端维修不因提到页面症状就强制重设计。UI-only仍严格只写client/，设计文档存client/design-system/；其他任务使用design-system/。

前置阶段只允许修改规范目录，宿主按真实diff检查，改业务则拒绝继续。规范包含MASTER.md七字段（主题/用户/主任务/布局/反模板/字体/配色）、有界tokens.json、至少一个pages/*.md。缺失/无效会阻止UI实现及最终提议。规范与代码进入同一个待人审变更集，不自动应用。

每轮模块、恢复、修复都显式读取同一规范并附文件hash及已完成模块摘要；最终重新校验。已存在有效规范默认延续，不每次重做；修复轮最小修改，不重新换色。当前策略基于任务文字和full/client范围启用，歧义场景仍需用户明确设计目标。

## 不盲信检索

真实离线测试发现长电商创作查询可能错误命中Pharmacy，CMS查询可能命中LMS。因此设计prompt要求核对category/source_identities，拒绝不相关行业要求、改用style/ux/stack定向检索并记录采纳/拒绝理由。不能把Skill推荐当需求、套用营销落地页到内部工作台。设计需业务适配，不保证装Skill后自动美观。

搜索默认stdout，禁止--persist、联网字体或安装；采用本地字体回退。上游--persist对已有祖先symlink缺乏保护，因此不作为平台默认写入方式。

## 真实证据与显示

宿主读取文件记录SHA256，runStep写DESIGN_REPORT报告，界面显示“设计规范已生成/缺失/无效”及“视觉验收未执行”。资源版本不等于模型实际使用；不接受模型自报视觉通过。最新报告无效时不回退旧有效报告。

本轮无自动付费模型运行，不伪造AI已读技能证明。已在真实非root、network none、read-only Worker内运行离线完整性与四组搜索冒烟。修复验证脚本Windows/Linux目录排序不同导致清单顺序不一致的问题，统一POSIX相对路径排序后两平台通过。

## 电商案例与验收边界

案例位于docs/design-cases/marketing-studio/，作为可审核设计提案，不覆盖当前业务系统、不写真实商品数据。视觉截图/交互检查必须单独记录，不把工程构建和设计规范有效性当视觉通过。当前自动任务视觉状态保留not_run；尚未实现通用浏览器视觉评审流水线。

## 适用性与后续

最终验证：1067项测试通过、9项跳过，类型检查、相关ESLint与生产构建通过；原4311项目开发页鉴权HTTP200，原4424 Python全栈预览已恢复。真实createIsolatedCodexEngine preflight识别两固定资源版本并成功释放隔离资源，模型执行次数为0。Worker内离线smoke四组全部通过。电商案例设计文件经collectDesignEvidence为specified，视觉状态仍not_run；案例另有有限的真实截图检查记录。

本轮覆盖已启用的Codex开发引擎；旧legacy生成器不假称已接入。版本更新需要重新审阅、维护来源并封存hash，不自动拉latest。部署资源目录是平台可信发布内容，必须与代码共同交付；hash清单不是对可写宿主管理员的防护边界。
