# DeepSeek官方生成链路修复

## 官方依据

用户提供的官方模型/价格与Chat Completions文档截图：deepseek-flash对应DeepSeek-V4.1-Flash，上下文1M，最大输出384K即393216 tokens。thinking默认enabled，reasoning_effort默认high；不设置max_tokens时非思考8K、思考64K（max effort128K）。response_format=json_object启用JSON Output，仍必须提示输出JSON。length也可能因上下文耗尽。

## 请求策略

只对deepseek供应商、deepseek-flash模型且HTTPS api.deepseek.com官方地址的结构化生成请求启用专用策略。请求明确申请393216输出tokens，并启用思考high及JSON Output。连接测试仍按小请求参数，不把它改成最大输出请求。其它供应商/反代不擅自套用官方能力参数。

通过流式接收完整结果，记录首响应时间、正文字符数和最终上游token用量（若返回）。不展示或持久化推理正文。开始/进度/完成/失败元数据写入断点；增量统计节流，完整结果才进行Schema、路径、动作及覆盖校验，然后创建变更集。

## 保留的正确性门槛

断流、错误事件、长度截断或不完整JSON不能当成成功。保留用户取消、安全错误摘要、稳定断点身份与安全拆批；不新增累计硬额度或固定模型截止。

不能保证上游永远不截断或断流。最大输出仍受上下文剩余空间和服务商真实能力约束，流式不是突破token额度的方式。

## 验证边界

使用SDK实际发送流程配合模拟HTTP/SSE验证请求字段，不对真实密钥发起请求，不自动继续项目任务。代码/协议验证与真实服务稳定性验证分开报告。

验证完成：33个测试文件477个测试通过，TypeScript与ESLint通过。实际安装的OpenAI Chat SDK配合模拟fetch/SSE断言HTTP请求包含stream:true、max_tokens:393216、response_format:{type:json_object}、thinking:{type:enabled}、reasoning_effort:high；短连接测试仍20token，不注入这些生成参数。

当前SDK不解析DeepSeek reasoning_content流字段，所以该传输的reasoningChars可能为0，不能据此声称未思考。返回usage中的reasoningTokens可记录；首段可识别内容耗时不等于HTTP响应头时间。不保存或展示推理正文。
