-- 兼容 MySQL 8 与 H2（MySQL 模式）。后续变更请新增 V2__xxx.sql，不要修改本文件。
CREATE TABLE sys_user (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  password_hash VARCHAR(100) NOT NULL,
  display_name VARCHAR(64) NOT NULL,
  role VARCHAR(32) NOT NULL,
  created_at DATETIME NOT NULL,
  CONSTRAINT uk_user_username UNIQUE (username)
);

CREATE TABLE auth_token (
  token VARCHAR(64) PRIMARY KEY,
  user_id BIGINT NOT NULL,
  expires_at DATETIME NOT NULL,
  CONSTRAINT fk_token_user FOREIGN KEY (user_id) REFERENCES sys_user (id)
);

CREATE TABLE notice (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  content TEXT NOT NULL,
  author_id BIGINT NOT NULL,
  created_at DATETIME NOT NULL,
  CONSTRAINT fk_notice_author FOREIGN KEY (author_id) REFERENCES sys_user (id)
);
