package com.graduate.app.auth;

import org.springframework.boot.CommandLineRunner;
import org.springframework.stereotype.Component;

/** 首次启动创建演示账号（与 delivery/contract.json 的 accounts 保持一致）。 */
@Component
public class DemoDataSeeder implements CommandLineRunner {
    private final UserRepository users;
    private final AuthService authService;

    public DemoDataSeeder(UserRepository users, AuthService authService) {
        this.users = users;
        this.authService = authService;
    }

    @Override
    public void run(String... args) {
        seed("admin", "Admin@123", "系统管理员", "ADMIN");
        seed("student", "Student@123", "演示学生", "USER");
    }

    private void seed(String username, String password, String displayName, String role) {
        if (users.findByUsername(username).isEmpty())
            users.save(new User(username, authService.hash(password), displayName, role));
    }
}
