# 模型配置页：手动测试连接

修改当前电商业务项目（不是平台设置页）。服务列表每行“编辑”旁增加“测试连接”。点击后使用后端已经保存的配置和密钥，不读取未保存编辑，不接受客户端URL或密钥，不生成文案或图片，不提交重试任务。

弹窗展示网络/服务响应、鉴权/模型列表、模型名称匹配三项及耗时。按钮pending并阻止重复提交，失败显示固定安全错误。列表未包含模型为需确认，不断言生成一定失败；404列表不支持为unsupported，401/403为鉴权失败，重定向拒绝跟随。仅接受已支持的OpenAI兼容协议。

管理员POST /api/admin/model-services/{id}/test-connection：固定GET已保存base_url+/models，无代理、无重定向、固定已校验DNS数字地址（HTTPS保留SNI及证书校验）、最大10秒、128KiB响应与5000模型限制。阻止metadata/linklocal及危险端口；允许当前授权内部relay:7863。只回安全中文信息，不回上游正文、原始异常或密钥。审计仅状态/耗时/model_calls0，不改配置或历史任务。

TCP与HTTP检测来自业务后端，不独立证明Worker、收费额度、生成质量或真实生成成功。生成调用次数始终0；列表GET是实际非生成HTTP请求。

已部署当前4424预览，实际服务1接口status passed，network/authentication/model三项通过，耗时871ms、model_calls0；未登录实际请求返回401。实际预览返回的新组件含testConnection按钮逻辑。

后端64项mock单测全部通过（1个现有TestClient弃用warning），覆盖权限、固定GET、地址策略、超时/TLS/重定向/响应限制与机密过滤。

前端Vite生产构建通过；真实脚本提取组件函数验证pending/防重复/成功/固定错误，未声称完整浏览器视觉验收。
