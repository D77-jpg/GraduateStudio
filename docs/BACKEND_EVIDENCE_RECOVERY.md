# 后端失败证据与自动补采修复

根因：控制台16K头尾截断丢失中段具名断言，诊断保护阻止模型猜测，但原流程缺自动补采。

执行器现在从stdout/stderr分别解码收集Node final test-at区块、TAP not-ok诊断和Vitest FAIL区块，失败证据单独写入failureEvidence，不同于限长console output。安全预算1MiB/4096行，超出明确标记failureEvidenceIncomplete，不伪造完整证据。数据库初始化导致取消子测试也不能被冒充为具名断言失败。

缺证据且检查可修复时自动针对缺证据检查重跑一次，合并并保存新报告后才决定是否修复，不重复调用模型猜测入口。完整采集流识别明确MySQL连接失败为blocked，不因中段错误被截断而遗漏环境阻塞。

真实验收执行器验证：当前生成backend-test returned blocked；控制台16000字符，另保存84142字符失败证据。明确错误为真实MySQL集成测试环境不可用（db主机连接失败）。144个诊断项含因父级初始化失败取消的子测试，所以仍有不完整标记，不会宣称全部测试有独立错误根因。原始报告存docs/backend-evidence-verification.json，供人工核对。

验证：39文件562测试通过，TypeScript/ESLint通过。真实数据库仍需配置/启动；本次只修平台证据闭环，不能称后端已通过或全项目完成。未自动恢复任务或发起真实模型请求。
