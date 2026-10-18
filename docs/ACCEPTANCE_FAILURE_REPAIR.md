# 工程验收失败排查与修复

## 范围

任务 `cmv9ls49m0001ubccpfxcafts`，项目 `cmv9krh9p0001ub64kc0o8bse`。
原项目未直接覆盖。修复副本：`.workspace/repair-cmv9ls49/project`。

## 真实复现

使用受限依赖代理仅下载wheel，随后在 `--network none`、非root、只读容器根文件系统中创建虚拟环境并执行完整pytest。保留完整JUnit和日志，未调用模型API。

最初443个测试中25个失败。核对源码后发现，不能将这些失败全部归因于业务实现：

- 密文存储为bytes，而测试对其执行字符串包含断言；测试夹具的加密口令与真实运行配置不同。
- 评估测试把字典当作HTTP响应传入；任务成功夹具只提供1个候选而业务要求至少2个。
- 应用关闭断言发生在测试客户端释放之前；历史版本审核测试错误地要求覆盖当前草稿状态。
- 空响应测试期待抛异常，而服务合同明确返回失败outcome；现在同时验证空内容不能持久化。
- 确有缺失的samples公开函数重导出、测试AssetSource导入、空结果明确文案、console request_id字段名。
- 正式复制复验发现图片测试未隔离上传路径。现在使用tmp_path并注入UPLOAD_DIR，真实写入图片后检查文件内容、数量，同时断言项目默认上传路径未变；不修改存储权限保护。此前错误码可定位到AssetStorageError，但未保留底层errno，不能声称具体是权限还是只读目录。
- `.env.example` 被统一隐私排除/隔离，导致交付文档引用的三个模板缺失。

修复不降低候选数量、密钥加密或历史版本保护，不删除失败测试或跳过测试。新增历史审核及日志标识回归。

直接隔离回归曾达到 `445 passed, 19 warnings in 55.53s`，pytest退出0。随后正式审计复制复验暴露3项图片测试对既有上传目录的隐性依赖，尚不能据此宣称最终通过；修复测试存储目录隔离后必须再次完整复验。平台全量回归：950通过、9跳过；TypeScript检查退出0。生产构建通过，已发布4311并验证登录任务接口HTTP200。Python真实Docker集成两项通过（成功与失败证据/命令计时）。

## 平台报告修复

- Codex Node/Python检查返回实际命令和测量耗时；未知值保持缺失，不填充虚假0ms。
- 组件缺少元数据显示“未知（未记录）”，不再宣称静态检查/未执行。
- Python测试结果保留JUnit失败用例名与简短错误，不仅保留日志尾。
- 删除“Python无验证器”“仅离线准备依赖”等过期说明。
- 安全环境示例仅通过严格校验后纳入审计、复制与变更集：精确文件名、16KiB、合法UTF8、固定占位与极窄非敏感配置白名单。实际`.env`和不安全示例继续隔离。

## 证据文件

- `.workspace/repair-cmv9ls49/evidence/pytest.xml`：完整pytest JUnit。
- `.workspace/repair-cmv9ls49/evidence/pytest.log`：完整测试输出。
- `.workspace/repair-cmv9ls49/evidence/failures.json`：最近一次完整执行的失败明细。
- `.workspace/repair-cmv9ls49/evidence/repaired-verification.json`：正式审计复制+Node/Python验证结果（完成后生成）。

## 最终验证与交付

从修复源重新建立正式审计副本（包括三个通过安全校验的示例）后完整验证通过：依赖passed、Node构建passed、Python编译passed、pytest 445项通过、0失败、0跳过。源文件清单校验未变。证据：`repaired-verification.json`。

已创建17文件的待审核变更集 `cmva8qo7p0001ub9kizbmap70`，通过已登录平台API核实可见且pending。原已应用项目未覆盖；任务指向这份修复，接受后自动进行应用后验证。提案清单：`.workspace/repair-cmv9ls49/evidence/proposal.json`。

前端没有声明测试脚本，保持not_run，不能因此声称前端测试通过；也不代表数据库/用户流程等业务验收完成。历史失败报告保留，不篡改历史以制造通过。
