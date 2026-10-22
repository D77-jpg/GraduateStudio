# 开发进度记录

每个模块完成后追加一节：新增的数据表、接口（方法 + 路径）、页面路由、测试类。

## 骨架（平台模板）
- 数据表：sys_user、auth_token、notice（示例纵切）
- 接口：GET /api/health；POST /api/auth/login；GET /api/auth/me；POST /api/auth/logout；GET/POST /api/notices；GET/DELETE /api/notices/{id}
- 页面：/login、/（首页）、/notices（公告管理示例）
- 测试：server `AuthAndNoticeApiTests`；client `src/__tests__/api.test.js`
