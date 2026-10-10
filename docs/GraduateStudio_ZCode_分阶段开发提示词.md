# GraduateStudio ZCode 分阶段开发提示词

> 本文档用于直接交给 ZCode / AI Coding Agent，按阶段开发 GraduateStudio。
>
> 核心原则：**先搭地基 → 产品工作台 → AI需求 → AI架构 → AI Coding → Agent自动开发 → Runtime → 测试修复 → 毕设文档 → 答辩 → 部署 → 最终打磨。**

---

# 一、产品定位

**GraduateStudio**

AI 驱动的计算机毕业设计自动开发平台。

核心目标：

> 让用户从一个毕业设计想法开始，经过选题、需求分析、架构设计、UI设计、数据库设计、AI开发、运行、测试、自动修复、部署、论文、答辩，最终完成一个完整的计算机毕业设计。

核心流程：

```text
选题
 ↓
需求分析
 ↓
产品设计
 ↓
系统架构
 ↓
数据库设计
 ↓
AI开发
 ↓
运行预览
 ↓
自动测试
 ↓
自动修复
 ↓
部署
 ↓
毕业设计文档
 ↓
答辩准备
 ↓
毕业设计完成
```

---

# 二、推荐开发阶段

```text
Phase 0  项目初始化 / 技术架构
Phase 1  产品壳层 + Dashboard
Phase 2  项目创建 + AI选题/需求分析
Phase 3  AI架构师 + 技术栈 + 数据库
Phase 4  AI Coding Workspace
Phase 5  Agent 自动开发闭环
Phase 6  Preview / Terminal / Logs
Phase 7  Testing + Debug
Phase 8  Git / Version
Phase 9  文档 / 论文
Phase 10 答辩中心
Phase 11 部署
Phase 12 全链路打磨
```

建议：

> **Phase 0～7 作为 GraduateStudio V1.0 MVP。**

先把：

```text
Idea
 ↓
Requirement
 ↓
Architecture
 ↓
Code
 ↓
Run
 ↓
Test
 ↓
Fix
```

完整跑通，再开发论文、答辩和部署。

---

# 三、Phase 0：项目初始化 / 技术架构

## 给 ZCode 的提示词

```text
你现在负责开发 GraduateStudio。

GraduateStudio 是一个 AI 驱动的计算机毕业设计自动开发平台。

产品核心目标：

让用户从一个毕业设计想法开始，经过：
选题 → 需求分析 → 架构设计 → UI设计 → 数据库 → AI开发 → 运行 → 测试 → 修复 → 部署 → 论文 → 答辩

最终完成一个完整的计算机毕业设计。

现在进入 Phase 0：项目基础架构。

要求：

1. 先检查当前代码仓库的完整结构。
2. 判断当前项目使用的技术栈、前后端结构、数据库方案、认证方案和已有能力。
3. 不要立即写代码。
4. 先输出：
   - 当前项目分析
   - 推荐架构
   - 目录结构
   - 核心数据模型
   - 页面路由规划
   - AI Agent 架构规划
   - 后续开发阶段建议
5. 如果项目已经存在代码，必须优先复用现有架构，不要无意义重构。
6. 不要提前实现 Phase 1 之后的业务功能。
7. 方案确认后再开始实施。
8. 最后运行现有测试、typecheck、lint、build，并确保基础工程正常。

这一阶段只建立 GraduateStudio 的稳定基础，不开发完整业务功能。
```

---

# 四、Phase 1：产品壳层 + Dashboard

## 目标

先把产品做成真正的软件工作台。

## 给 ZCode 的提示词

```text
进入 GraduateStudio Phase 1。

目标：
完成产品基础 UI、应用 Shell 和 Dashboard。

本阶段只做：

1. 全局 Layout
2. Sidebar
3. Topbar
4. Dashboard
5. 项目列表
6. 项目卡片
7. 新建项目入口
8. 最近项目
9. 项目进度展示
10. 空状态
11. Loading 状态
12. Error 状态
13. 基础响应式布局

产品风格：

- 高级 SaaS / AI IDE
- 简洁
- 现代
- 高级
- 避免传统后台管理系统风格
- 避免过度渐变和廉价 AI 风
- 强调信息层级、留白、排版和交互
- 桌面端优先

Dashboard 核心信息：

- 我的毕业设计
- 最近项目
- 当前开发阶段
- 项目完成度
- 技术栈
- 最近修改时间
- 快速继续开发

暂时不要实现：

- 真正 AI Coding
- Agent
- 论文生成
- 答辩
- 部署
- Git
- 自动测试

可以建立必要的数据模型和 mock 数据，但架构必须方便后续替换成真实数据。

完成后：
1. typecheck
2. lint
3. build
4. 浏览器 smoke test
5. 修复所有阻塞问题
6. 汇报完成内容和下一阶段建议。
```

---

# 五、Phase 2：项目创建 + AI选题 + 需求分析

## 给 ZCode 的提示词

```text
进入 GraduateStudio Phase 2。

目标：
建立「项目创建 → AI选题 → AI需求分析」完整流程。

实现：

一、创建项目
- 项目名称
- 项目描述
- 项目类型
- 开发语言
- 技术栈偏好
- 难度
- 数据库偏好
- 是否需要 AI 能力

二、AI选题中心

用户可以输入模糊想法，例如：
“我想做一个校园二手交易系统。”

AI需要输出：
- 项目名称
- 项目简介
- 项目背景
- 项目目标
- 项目类型
- 推荐技术栈
- 难度
- 创新性评分
- 实现难度评分
- 论文友好度
- 答辩展示度
- 综合评分

三、需求分析

AI自动生成：
- 用户角色
- 功能模块
- 功能树
- 核心业务流程
- 非功能需求
- 系统边界
- 开发任务列表

四、需求编辑

用户可以：
- 修改需求
- 删除功能
- 增加功能
- 让 AI 重新分析
- 重新生成某个模块

重要要求：

AI生成内容必须结构化保存到数据库，而不是只存在聊天记录里。

建立 Project / Requirement / Feature / UserRole 等合理数据模型。

暂时不要实现真正的代码生成。

不要实现论文、答辩、部署。

完成后执行完整测试和 build。
```

---

# 六、Phase 3：AI架构师

## 给 ZCode 的提示词

```text
进入 GraduateStudio Phase 3。

目标：
实现 Architect Agent，让用户的毕业设计需求可以自动转换成可执行的软件架构。

实现：

1. 技术栈推荐
2. 系统架构设计
3. 前后端架构
4. API 模块规划
5. 数据库设计
6. 权限设计
7. 项目目录结构
8. 技术选型理由

用户可以点击：

「AI生成系统架构」

AI根据当前 Project + Requirements 自动生成。

需要结构化保存：

Architecture
TechnologyStack
Module
ApiDefinition
DatabaseSchema
PermissionRule

数据库设计支持：
- 表
- 字段
- 类型
- 索引
- 主键
- 外键
- 表关系

提供可视化数据库/ER设计页面。

重要：

需求修改后，允许 AI 重新分析架构。

但是不要自动破坏用户已经确认的架构。

提供：
- AI建议
- 用户确认
- 用户拒绝
- 局部重新生成

暂时不要进入真正 AI Coding。

完成后进行完整测试、typecheck、lint、build。
```

---

# 七、Phase 4：AI Coding Workspace

## 给 ZCode 的提示词

```text
进入 GraduateStudio Phase 4。

目标：
建立 AI Coding Workspace。

整体体验参考：
Cursor / Claude Code / Windsurf / Replit。

页面结构：

左：
Project Files

中：
Code Editor

右：
AI Agent

底部：
Terminal / Logs / Problems

实现：

1. 文件树
2. 文件打开
3. 代码编辑
4. 文件搜索
5. 全局搜索
6. AI聊天
7. AI生成代码
8. AI修改代码
9. Diff
10. Accept / Reject
11. 多文件修改
12. Undo / Restore
13. Terminal
14. Command execution
15. Logs

AI必须能够理解当前项目上下文：

Project
Requirements
Architecture
Database
Files

用户可以输入：

“实现用户登录功能。”

AI应该分析项目后生成修改计划。

先展示：

Plan

然后执行：

Create
Modify
Delete

最终展示 Diff。

用户确认后才正式应用修改。

重要：
不要实现危险的无限自动执行。

所有文件修改必须有可追踪的变更记录。

完成后进行真实项目测试。
```

---

# 八、Phase 5：Agent 自动开发闭环

这是 GraduateStudio 的核心能力。

## 给 ZCode 的提示词

```text
进入 GraduateStudio Phase 5。

目标：
实现 Autonomous Development Loop。

用户创建一个开发任务：

例如：

“实现用户登录、注册和 JWT 鉴权。”

系统自动执行：

1. 分析需求
2. 分析现有项目
3. 制定开发计划
4. 创建/修改代码
5. 安装必要依赖
6. 启动项目
7. 执行 typecheck
8. 执行 lint
9. 执行测试
10. 分析错误
11. 自动修复
12. 重新测试
13. 输出最终结果

状态需要实时展示：

Planning
Analyzing
Coding
Running
Testing
Debugging
Fixing
Completed
Failed
Paused

例如：

Task #12

Implement User Authentication

✓ Analyze project
✓ Create login page
✓ Create auth API
✓ Create JWT service
✓ Update database

Running tests...

✕ 2 tests failed

AI Debugger

Analyzing...

✓ Fix authentication middleware

Running again...

✓ 18/18 passed

最终：
Task Completed

重要要求：

1. Agent 必须有最大执行次数。
2. Agent 必须支持暂停。
3. Agent 必须支持取消。
4. Agent 必须保存执行日志。
5. 每一步都必须可追踪。
6. 不允许无限循环。
7. 高风险操作需要用户确认。
8. 失败后必须保留完整错误上下文。

先实现可靠闭环，不追求复杂 UI。
```

---

# 九、Phase 6：Preview + Terminal + Runtime

## 给 ZCode 的提示词

```text
进入 GraduateStudio Phase 6。

目标：
建立项目 Runtime 环境。

实现：

1. 项目启动
2. Web Preview
3. Terminal
4. Console
5. Logs
6. Process 状态
7. Port 管理
8. Environment Variables
9. Restart
10. Stop
11. Run
12. Build

页面布局：

顶部：
Run / Stop / Restart

中间：
Browser Preview

底部：
Terminal / Logs / Problems

Agent 必须能够读取：
- 编译错误
- Runtime Error
- API Error
- Terminal 输出
- Test 输出

并把错误上下文提供给 Debug Agent。

重点：
必须真实运行项目，不要用假的 loading 或模拟日志冒充真实执行。

完成后进行真实 E2E 验证。
```

---

# 十、Phase 7：Testing + Debug

## 给 ZCode 的提示词

```text
进入 GraduateStudio Phase 7。

目标：
建立 AI Testing + Debugging 系统。

实现：

一、测试中心
- Unit Test
- Integration Test
- API Test
- E2E Test
- Permission Test

二、AI生成测试

根据 Requirements + Architecture + Code 自动生成测试。

三、测试执行

展示：

87 / 92 Passed
5 Failed

四、失败分析

AI自动分析：

- Error
- Stack Trace
- Related File
- Related Requirement
- Possible Cause

五、AI Fix

提供：

Fix
Fix All
Ignore
Retry

六、回归测试

Bug修复后自动重新运行相关测试。

核心闭环：

Code
 ↓
Test
 ↓
Fail
 ↓
Analyze
 ↓
Fix
 ↓
Test
 ↓
Pass

必须保存 TestRun 和 TestResult。

完成后必须跑完整 E2E。
```

---

# 十一、V1.0 MVP 验收

完成 Phase 0～7 后，不要立即进入下一阶段。

先进行一次完整 MVP 验收。

## 验收目标

GraduateStudio 必须能够完成：

```text
用户创建项目
 ↓
输入毕业设计想法
 ↓
AI生成需求
 ↓
AI生成架构
 ↓
进入 Coding Workspace
 ↓
AI生成/修改代码
 ↓
真实运行项目
 ↓
发现错误
 ↓
AI分析错误
 ↓
自动修复
 ↓
重新测试
 ↓
最终通过
```

## 验收标准

```text
□ 项目可以创建
□ 项目数据可以持久化
□ AI需求可以生成
□ AI需求可以编辑
□ AI架构可以生成
□ 数据库设计可以保存
□ Coding Workspace 可用
□ 文件树可用
□ 代码编辑器可用
□ AI可以读取项目上下文
□ AI可以修改多个文件
□ Diff可查看
□ 修改可以Accept / Reject
□ Terminal真实可用
□ 项目可以真实启动
□ Preview真实可用
□ Logs真实可用
□ Agent可以执行开发任务
□ Agent可以暂停
□ Agent可以取消
□ Agent有最大执行次数
□ Agent有完整日志
□ 测试可以真实执行
□ 测试失败可以被分析
□ AI可以自动修复
□ 修复后可以重新测试
□ 不允许无限循环
□ 不使用假数据冒充真实核心能力
□ typecheck通过
□ lint通过
□ build通过
□ E2E通过
```

---

# 十二、Phase 8：Git / Version

## 给 ZCode 的提示词

```text
进入 GraduateStudio Phase 8。

目标：
建立项目版本控制能力。

实现：

- Git初始化
- Commit
- Branch
- Diff
- History
- Rollback
- Restore
- AI Commit Message

每次 AI Agent 完成一个稳定任务后，可以生成：

Commit

例如：

feat: implement user authentication

同时记录：

- 修改文件
- 修改内容
- Agent Task
- 测试结果

用户必须能够恢复到之前稳定版本。

不要做复杂 GitHub SaaS 功能，本阶段只解决项目本地版本管理。
```

---

# 十三、Phase 9：毕业设计文档

## 给 ZCode 的提示词

```text
进入 GraduateStudio Phase 9。

目标：
实现 AI 毕设文档中心。

根据实际项目自动生成：

1. 开题报告
2. 任务书
3. 文献综述
4. 需求分析
5. 系统设计
6. 数据库设计
7. 系统实现
8. 系统测试
9. 总结
10. 参考文献

核心要求：

文档不能脱离实际项目。

AI必须读取：

Project
Requirements
Architecture
Database
Code
Tests

然后生成对应内容。

支持：

- 编辑
- AI润色
- AI扩写
- AI缩写
- 重新生成章节
- 保存版本
- 导出 Markdown
- 导出 DOCX / PDF

建立 Document / DocumentSection / DocumentVersion 数据模型。

重点：
代码、数据库、测试发生变化后，可以提示用户同步更新相关文档。
```

---

# 十四、Phase 10：答辩中心

## 给 ZCode 的提示词

```text
进入 GraduateStudio Phase 10。

目标：
建立 AI 毕业答辩中心。

实现：

1. AI生成答辩PPT结构
2. AI生成答辩问题
3. 项目知识库
4. AI模拟答辩
5. 回答评分
6. 弱项分析
7. 追问模式

问题必须基于当前真实项目生成。

例如：

“为什么你的系统选择 JWT 而不是 Session？”

AI需要根据项目实际技术栈进行提问。

答辩评分：

- 技术理解
- 项目理解
- 回答完整度
- 专业性
- 表达清晰度

最终生成：

答辩准备度评分。
```

---

# 十五、Phase 11：部署中心

## 给 ZCode 的提示词

```text
进入 GraduateStudio Phase 11。

目标：
实现项目部署能力。

支持：

- Docker
- VPS
- Vercel
- Railway
- Render

AI自动生成：

- Dockerfile
- docker-compose.yml
- 环境变量模板
- 部署脚本
- README

提供：

Build
Deploy
Logs
Restart
Rollback

不要一开始做复杂云平台集成。

优先实现：
Docker + 用户自己的服务器部署流程。
```

---

# 十六、Phase 12：最终产品打磨

## 给 ZCode 的提示词

```text
进入 GraduateStudio Phase 12。

现在停止增加新功能。

目标：
对整个产品进行生产级质量打磨。

检查：

1. UI一致性
2. 页面响应速度
3. Loading
4. Empty State
5. Error State
6. Toast
7. Dialog
8. Keyboard Shortcut
9. Mobile/Tablet兼容
10. 权限
11. 数据一致性
12. Agent稳定性
13. 长任务恢复
14. 并发问题
15. 数据库索引
16. API错误处理
17. 日志
18. 安全
19. 类型安全
20. Build

执行：

typecheck
lint
unit tests
integration tests
E2E
build

修复所有阻塞问题。

不要新增大型功能。

最终输出：
- 产品完成度
- 已知问题
- 技术债务
- 测试结果
- 性能问题
- 下一步建议
```

---

# 十七、每个阶段都必须附加的开发纪律

建议每次提示词最后都加入以下规则：

```text
开发纪律：

1. 先检查现有代码，不要盲目重写。
2. 先分析，再实施。
3. 不要擅自增加当前阶段之外的功能。
4. 不要为了完成任务删除已有功能。
5. 优先复用已有组件、服务和数据模型。
6. 修改数据库必须提供 migration。
7. 修改 API 必须同步更新调用方。
8. 修改类型必须保证 typecheck 通过。
9. 完成功能后必须自己测试。
10. 出现错误必须优先修复，而不是绕过。
11. 不允许用 mock、假数据、setTimeout、假 loading 冒充真实功能，除非当前阶段明确要求 mock。
12. 不允许留下 TODO 代替核心功能。
13. 所有重要 AI 操作必须有日志和错误处理。
14. 不要因为某个测试失败就删除测试。
15. 不要修改无关代码。
16. 完成后报告：
   - 修改了什么
   - 新增了什么
   - 修改了哪些文件
   - 数据库是否变化
   - 测试结果
   - 是否存在已知问题
```

---

# 十八、推荐开发节奏

```text
                    GraduateStudio
                           │
                           ▼
                 Phase 0 基础架构
                           │
                           ▼
                 Phase 1 产品 UI
                           │
                           ▼
                 Phase 2 AI 需求
                           │
                           ▼
                 Phase 3 AI 架构
                           │
                           ▼
                 Phase 4 AI Coding
                           │
                           ▼
                 Phase 5 Agent Loop
                           │
                           ▼
                 Phase 6 Runtime
                           │
                           ▼
                 Phase 7 Testing
                           │
                           ▼
                    ★ V1.0 MVP ★
                           │
                    ┌──────┴──────┐
                    ▼             ▼
                 Phase 8       Phase 9
                  Git           论文
                    │             │
                    └──────┬──────┘
                           ▼
                       Phase 10
                         答辩
                           │
                           ▼
                       Phase 11
                         部署
                           │
                           ▼
                       Phase 12
                       产品打磨
```

---

# 十九、最关键的产品闭环

GraduateStudio 最终应该做到：

```text
用户想法
   ↓
AI需求
   ↓
AI架构
   ↓
AI Coding
   ↓
真实运行
   ↓
自动测试
   ↓
自动修复
   ↓
Git版本
   ↓
论文生成
   ↓
答辩模拟
   ↓
部署
```

最终产品定位：

> **GraduateStudio = AI + IDE + Agent + 毕设工作流 + 文档 + 答辩**

不是单纯的 AI Coding 工具，而是：

> **AI Graduation Project Operating System**
>
> AI 驱动的计算机毕业设计操作系统。
