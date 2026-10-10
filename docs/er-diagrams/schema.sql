-- 基于大语言模型的算法题智能辅导系统 · 数据库设计(MySQL 8.0)
-- 由 GraduateStudio AI 架构师生成并通过用户确认

-- 存储学生与教师账号、个人资料及学习偏好。
CREATE TABLE users (
  id BIGINT PRIMARY KEY COMMENT '用户主键',
  username VARCHAR(64) UNIQUE NOT NULL COMMENT '登录用户名',
  email VARCHAR(255) UNIQUE COMMENT '登录邮箱',
  password_hash VARCHAR(255) NOT NULL COMMENT 'BCrypt 密码摘要',
  display_name VARCHAR(100) NOT NULL COMMENT '显示名称',
  avatar_url VARCHAR(500) COMMENT '头像地址',
  target_difficulty VARCHAR(20) NOT NULL COMMENT '目标练习难度',
  daily_practice_count INT NOT NULL COMMENT '每日练习目标数量',
  status VARCHAR(20) NOT NULL COMMENT '账号状态',
  last_login_at DATETIME COMMENT '最近登录时间',
  created_at DATETIME NOT NULL COMMENT '创建时间',
  updated_at DATETIME NOT NULL COMMENT '更新时间'
) COMMENT '存储学生与教师账号、个人资料及学习偏好。';

-- 定义学生、教师等系统角色。
CREATE TABLE roles (
  id BIGINT PRIMARY KEY COMMENT '角色主键',
  code VARCHAR(50) UNIQUE NOT NULL COMMENT '角色编码，如 student、teacher',
  name VARCHAR(100) NOT NULL COMMENT '角色名称',
  description VARCHAR(255) COMMENT '角色说明',
  created_at DATETIME NOT NULL COMMENT '创建时间',
  updated_at DATETIME NOT NULL COMMENT '更新时间'
) COMMENT '定义学生、教师等系统角色。';

-- 定义后端接口和管理操作对应的权限点。
CREATE TABLE permissions (
  id BIGINT PRIMARY KEY COMMENT '权限主键',
  code VARCHAR(100) UNIQUE NOT NULL COMMENT '权限编码',
  module VARCHAR(100) NOT NULL COMMENT '所属模块',
  action VARCHAR(20) NOT NULL COMMENT '操作类型，如 list、create、audit',
  description VARCHAR(255) COMMENT '权限说明',
  created_at DATETIME NOT NULL COMMENT '创建时间',
  updated_at DATETIME NOT NULL COMMENT '更新时间'
) COMMENT '定义后端接口和管理操作对应的权限点。';

-- 关联用户与角色，支持一个用户拥有多个角色。
CREATE TABLE user_roles (
  id BIGINT PRIMARY KEY COMMENT '关联主键',
  user_id BIGINT NOT NULL COMMENT '用户 ID',
  role_id BIGINT NOT NULL COMMENT '角色 ID',
  created_at DATETIME NOT NULL COMMENT '创建时间',
  updated_at DATETIME NOT NULL COMMENT '更新时间'
) COMMENT '关联用户与角色，支持一个用户拥有多个角色。';

-- 关联角色与权限点以实施服务端 RBAC 授权。
CREATE TABLE role_permissions (
  id BIGINT PRIMARY KEY COMMENT '关联主键',
  role_id BIGINT NOT NULL COMMENT '角色 ID',
  permission_id BIGINT NOT NULL COMMENT '权限 ID',
  created_at DATETIME NOT NULL COMMENT '创建时间',
  updated_at DATETIME NOT NULL COMMENT '更新时间'
) COMMENT '关联角色与权限点以实施服务端 RBAC 授权。';

-- 记录登录、题目发布、批改触发和审核等关键操作。
CREATE TABLE audit_logs (
  id BIGINT PRIMARY KEY COMMENT '日志主键',
  user_id BIGINT COMMENT '操作用户 ID',
  module VARCHAR(100) NOT NULL COMMENT '操作模块',
  action VARCHAR(50) NOT NULL COMMENT '操作类型',
  target_type VARCHAR(100) COMMENT '操作目标类型',
  target_id BIGINT COMMENT '操作目标 ID',
  detail JSON COMMENT '操作详情',
  ip_address VARCHAR(45) COMMENT '客户端 IP',
  created_at DATETIME NOT NULL COMMENT '创建时间',
  updated_at DATETIME NOT NULL COMMENT '更新时间'
) COMMENT '记录登录、题目发布、批改触发和审核等关键操作。';

-- 存储课程知识点及其层级、难度等基础信息。
CREATE TABLE knowledge_points (
  id BIGINT PRIMARY KEY COMMENT '知识点主键',
  parent_id BIGINT COMMENT '父知识点 ID',
  code VARCHAR(64) UNIQUE NOT NULL COMMENT '知识点编码',
  name VARCHAR(128) NOT NULL COMMENT '知识点名称',
  description TEXT COMMENT '知识点说明',
  difficulty_level TINYINT NOT NULL COMMENT '知识点难度等级',
  status VARCHAR(20) NOT NULL COMMENT '知识点状态',
  created_at DATETIME NOT NULL COMMENT '创建时间',
  updated_at DATETIME NOT NULL COMMENT '更新时间'
) COMMENT '存储课程知识点及其层级、难度等基础信息。';

-- 维护知识点之间的先修或相关关系以支持图谱推荐。
CREATE TABLE knowledge_relations (
  id BIGINT PRIMARY KEY COMMENT '关系主键',
  source_knowledge_point_id BIGINT NOT NULL COMMENT '起点知识点 ID',
  target_knowledge_point_id BIGINT NOT NULL COMMENT '终点知识点 ID',
  relation_type VARCHAR(30) NOT NULL COMMENT '关系类型，如 prerequisite、related',
  created_at DATETIME NOT NULL COMMENT '创建时间',
  updated_at DATETIME NOT NULL COMMENT '更新时间'
) COMMENT '维护知识点之间的先修或相关关系以支持图谱推荐。';

-- 保存正式题目与审核发布后的变式题内容。
CREATE TABLE problems (
  id BIGINT PRIMARY KEY COMMENT '题目主键',
  source_problem_id BIGINT COMMENT '生成变式题所依据的题目 ID',
  created_by_user_id BIGINT COMMENT '创建者或生成任务发起人 ID',
  title VARCHAR(255) NOT NULL COMMENT '题目标题',
  statement LONGTEXT NOT NULL COMMENT '题面内容',
  input_description TEXT COMMENT '输入说明',
  output_description TEXT COMMENT '输出说明',
  constraints_text TEXT COMMENT '数据范围与约束',
  difficulty VARCHAR(20) NOT NULL COMMENT '题目难度',
  time_limit_ms INT NOT NULL COMMENT '执行时间限制毫秒数',
  memory_limit_mb INT NOT NULL COMMENT '内存限制 MB',
  reference_solution LONGTEXT COMMENT '参考题解或代码',
  solution_explanation LONGTEXT COMMENT '静态题解说明及降级展示内容',
  status VARCHAR(20) NOT NULL COMMENT '题目状态，如 draft、pending、published、rejected',
  origin_type VARCHAR(20) NOT NULL COMMENT '题目来源，如 manual、generated、imported',
  published_at DATETIME COMMENT '发布时间，未发布为空值表示未发布状态。字段实际允许为空。 '
) COMMENT '保存正式题目与审核发布后的变式题内容。';

-- 外键关系
ALTER TABLE user_roles ADD FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE user_roles ADD FOREIGN KEY (role_id) REFERENCES roles(id);
ALTER TABLE role_permissions ADD FOREIGN KEY (role_id) REFERENCES roles(id);
ALTER TABLE role_permissions ADD FOREIGN KEY (permission_id) REFERENCES permissions(id);
ALTER TABLE audit_logs ADD FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE knowledge_points ADD FOREIGN KEY (parent_id) REFERENCES knowledge_points(id);
ALTER TABLE knowledge_relations ADD FOREIGN KEY (source_knowledge_point_id) REFERENCES knowledge_points(id);
ALTER TABLE knowledge_relations ADD FOREIGN KEY (target_knowledge_point_id) REFERENCES knowledge_points(id);
ALTER TABLE problems ADD FOREIGN KEY (source_problem_id) REFERENCES problems(id);
ALTER TABLE problems ADD FOREIGN KEY (created_by_user_id) REFERENCES users(id);