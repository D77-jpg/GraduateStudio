# 当前电商项目演示数据导入记录

目标项目：cmv9krh9p0001ub64kc0o8bse，预览 http://localhost:4424 。用户明确授权实际写入演示数据，保留原记录、不调用真实模型。

## 实际写入与API验证

- 商品8（SKU GS-DEMO-V1-P01..P08）：保温杯、洗面奶、蜂蜜茶、耳机、T恤、婴儿衣、中性笔、瑜伽垫。
- 商品图片8：通过真实鉴权上传API写入持久卷；PNG为程序绘制几何占位，明确DEMO/NOT PHOTO，不是商品实拍或AI生成图。
- 任务8：DEMO-MANUAL-NO-MODEL，无真实模型请求或TaskAttempt。因当前任务枚举不支持demo/cancelled，状态failed、错误码DEMO_NOT_EXECUTED，错误描述明确演示未执行。不要将其当成模型故障，也不要直接重试。
- 手工候选16：每任务2条，JSON元数据标记manual_demo_seed/model_called=false。
- 内容位8、导入版本16：草稿、待审、通过、退回各2；每内容位2个版本。来源为imported，不冒充generated。
- 模拟审核记录4：意见明确是演示状态，非真实人工审批证据。
- 实际规则检查命中10：使用项目现有flush-only规则检查器，对新演示版本检查；不是伪造检查结果。
- 评估样例64：56组内置样例通过真实import API新增（created56/updated0），另8组GS-DEMO-V1演示样例停用。
- 评估记录16：明确未执行的failed记录，无候选、质量分、人工评分、耗时或成功模型结果。统计页不得用于论文真实模型对比结论，演示模型code应单独排除。
- 导出6：商品3及7的演示已通过版本，各plain_text/csv/json一份。通过真实鉴权导出服务落盘，6个download URL均验证HTTP成功且非空（738/539/1511/764/565/1530 bytes）。导出内容仍是演示数据，非实际商业审核通过内容。
- 原已有提示模板4、检查规则8、管理员1，保持不变。真实模型服务0，不创建假服务或密钥。

API逐项读取8个商品/8内容位/8任务成功，每内容位versions=2、每任务candidates=2。内容status依次draft,pending_review,approved,rejected重复两轮。评估runs=16、samples=64、exports=6。

## 写入安全与复用

脚本 `.workspace/cmv9krh9p0001ub64kc0o8bse/server/scripts/seed_demo_business.py`：默认dry-run只读；--apply单transaction，异常rollback；固定完成操作日志+业务唯一键实现幂等；仅新增不覆盖旧业务记录。真实数据库重复apply返回already_seeded=true。独立SQLite验证冲突时全事务回滚。

真实后端容器源码read-only、uid10001；没有修改权限或安装依赖。docker cp被readonly拒绝后未扩大权限，改为现有Python进程内加载经审核脚本文本执行；使用现有环境连接已有数据库，不读取.env或输出凭证。图片/导出通过受鉴权业务API写入受管data卷。

执行辅助脚本：`.workspace/verify-demo-data.ps1`（仅登录及读取计数，不输出凭证），`.workspace/finish-demo-assets.ps1`（演示图片与导出，检查已有记录避免重复），`.workspace/create-demo-placeholder.py`（标准库生成明确标记占位PNG）。

## 使用入口

刷新现有预览：商品资料看图片和事实；内容协同审核筛选各状态、打开版本/检查命中，候选比较可加载任务1..8；内容导出可查6份文件；评估样例看56内置+8停用demo，评估统计仅展示未执行记录，无真实得分。账号管理保留真实管理员；模型服务为空是有意的，不是导入遗漏。

未执行真实模型生成、图像生成、模型评分或完整浏览器端到端验收；本记录证明真实数据写入/API读取/导出可下载，不等于全部业务已经验收通过。
