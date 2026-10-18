# 纸页 Papertrail · 营销创作工作台设计案例

> 设计提案·示例数据·非业务系统。本目录是可审核的静态设计交付，不是对用户应用的部署或自动修改。

## 打开与范围

直接用本地浏览器打开 `preview.html`，不需要 npm 安装、服务启动、外网、字体下载或模型调用。仅本目录新增文件；没有修改用户项目、.env、应用路由、业务数据或服务。没有重启应用、调用付费模型或生成图片资源。

预览是中文、inline CSS/JS、inline SVG 图标。两件示例商品图形全部由 CSS 绘制，并持续标记“CSS 图片占位 · 非商品实拍”。不是生成资源，不证明真实商品外观。示例商品名称、SKU、规格、人员、时间、版本和文案均为人工编写演示数据。

## 文件结构

- `design-system/MASTER.md`：主题、用户、主任务、布局、反模板、字体、配色七字段；业务依据、检索拒绝理由和语义色说明。
- `design-system/tokens.json`：严格 codex-design schema，仅 version/colors/typography/spacing/radius 及指定子字段。
- `design-system/pages/products.md`：商品图片与事实完整度任务。
- `design-system/pages/creation.md`、`design-system/pages/review.md`：文案预览与审核队列任务。
- `creation/review.md`：创作到审核跨页不变量。
- `preview.html`：三个可切换视图，桌面/窄屏响应式本地提案。
- `verify.mjs`：不依赖第三方包的静态与 DOM 契约检查。

## 真实业务与来源

只读 `.workspace/cmv9krh9p0001ub64kc0o8bse/client/src/` 下的以下文件，未读取 `.env`：

| 文件 | 本次读取内容 | 对设计的影响 |
| --- | --- | --- |
| `router/index.js` | 路由完整文件 | 商品资料→生成配置→内容协同审核；creator/admin 编辑权限，reviewer 审核任务 |
| `views/products/ProductListView.vue` | 完整文件 | 名称、SKU、人群、规格、卖点、图片数、状态与生成入口；改为图像+事实卡，而非换色表格 |
| `views/generation/GenerationConfigView.vue` | 模板第 1–230 行 | 事实快照、场景必需项、渠道、2–3候选、异步任务、模型参数与配图人工核验 |
| `views/content/ContentWorkspaceView.vue` | 模板第 1–260 行 | 只读版本、编辑新建版本、版本 diff、规则命中与定位、人工审核而非自动合规认证 |

完整度“3/4 项”是设计提案的示例检查，不宣称原 API 存在完整度字段。正式落地必须按 required_facts 计算场景缺项；asset_count 只代表数量，封面 URL 需核对真实接口。候选预览不是新生成结果。高级配置与既有版本链、diff、日志、任务中心、导出功能不可因本提案而删除。

## 资源建议 + 人工综合（检索不是权威）

不称“已经使用 UI UX Pro Max / frontend-design 两项技能”。本委派会话未执行这两项技能，内容来自上述代码观察、人工综合，以及父代理提供的真实检索发现：

- `ecommerce marketing...` 检索错分 **Pharmacy**；拒绝处方校验、药品剂量等无关规则。
- `Content Management CMS` 检索错分 **LMS**；拒绝课程表、学习进度等无关规则。

这些误分类不能成为业务需求。可参考通用对比度、清晰导航和键盘焦点建议，但必须经主题/用户/主任务审计。后续如补查设计资源，应改用明确工作台类型和 style/ux、Vue 定向检索，而不是照搬 Pharmacy/LMS 规则或营销落地页 hero。资源建议仅限现有 ElementPlus、本地系统字体、授权后的真实商品素材；没有下载新资源。

## ElementPlus 可落地映射（仅建议，未实施）

| 提案 | 现有技术映射 | 不可越过的边界 |
| --- | --- | --- |
| 轻侧栏/窄屏流程导航 | `ElContainer`、`ElAside`、`ElMenu`，原 Vue Router | 不替换路由守卫或角色授权 |
| 商品图片卡+事实栏 | `ElCard`、`ElImage`、`ElDescriptions`、`ElTag` | 使用真实授权资源与 alt；封面字段先确认，加载失败显式占位 |
| 搜索、事实状态过滤 | `ElInput`、`ElSelect`、既有分页 | 服务端筛选能力需确认，不能拿两条本地示例冒充全库统计 |
| 文案配置与候选 | `ElForm`、`ElSelect`、`ElRadioGroup`、`ElTabs`、`ElInput` textarea | 接回既有 async task、幂等键与事实快照；模型参数折叠不删除 |
| 审核队列与事实对照 | `ElCard`、`ElTag`、`ElDescriptions`、`ElAlert` | 保留当前/已批准版本、规则定位与版本 diff，未命中≠合规 |
| 提交、通过、退回 | `ElButton`、`ElMessage`、`ElMessageBox` | 正式实现调用现有 API 后才可报成功；预览只说明示意 |
| tokens | CSS variables 与 `--el-color-primary:#275E4A` 等主题变量 | 状态色单独映射；不要把每个旧页面全局强制换色 |

正式实施需要单独确认，不在本任务内。预览 HTML 刻意不依赖 CDN/ElementPlus runtime，便于离线审阅。

## 已执行文件测试与未执行项

运行：

```sh
node docs/design-cases/marketing-studio/verify.mjs
```

本轮实际运行通过：严格 tokens key/值、离线依赖约束、唯一 ID、JS 解析、三个视图切换、商品搜索/缺项过滤/上下文、候选切换、正文 textContent 更新、审核选择/命中定位、退回意见必填以及操作诚实反馈。测试使用 Node VM + 最小 DOM stub；**不代表真实浏览器或视觉验收**。

父代理可从仓库已有实现只读收集规范证据：

```ts
collectDesignEvidence(path.resolve('docs/design-cases/marketing-studio'), { required: true })
```

预期采集 `design-system/MASTER.md`、`tokens.json` 和 `pages/*.md`，不会采集本目录预览及联合作业文档。父代理负责实际运行与记录结果，不把预期当实测。`specified` 仅证明规范齐备，不能宣称视觉通过。`visual.status=not_run`，`reason=未执行真实浏览器截图视觉检查`。

### 父验收 / 人工浏览器清单

- 在本地 file:// 打开；断网仍可操作；确认顶部免责声明始终可见。
- 桌面 1440px、窄屏 390px 与最窄 320px 查看布局，无横向溢出、遮挡或无意义 KPI。
- 只用 Tab / Enter / Space：切页、选商品、筛选、候选、编辑、审核队列均可操作且焦点可见。
- 搜索无匹配显示空状态；清除筛选恢复；选帆布袋时事实栏和创作上下文同步，显示配图待补充。
- 改渠道只更新标签并说明未重新生成；改语气说明示意；编辑正文显示未保存；切换候选重置编辑。
- 审核第一项定位“全天恒温”；第二项无命中但仍要求人工判断；空意见退回聚焦意见框。
- 生成、提交、通过、退回均只解释，没有真实成功宣称、保存、通知、真实接口或付费模型调用。
- 检查 CSS 占位标签、文本对比度、320px 按钮换行、读屏 label 和状态播报。

尚未执行真实浏览器截图、视觉检查、辅助技术测试及生产 API 集成测试。无截图资产，未声称审美或无障碍验收通过。
