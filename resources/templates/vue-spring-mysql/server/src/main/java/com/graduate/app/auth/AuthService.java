package com.graduate.app.auth;

import com.graduate.app.common.BusinessException;
import java.time.LocalDateTime;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AuthService {
    private final UserRepository users;
    private final AuthTokenRepository tokens;
    private final BCryptPasswordEncoder encoder = new BCryptPasswordEncoder();
    private final long ttlHours;

    public AuthService(UserRepository users, AuthTokenRepository tokens,
                       @Value("${app.token-ttl-hours:72}") long ttlHours) {
        this.users = users;
        this.tokens = tokens;
        this.ttlHours = ttlHours;
    }

    public String hash(String raw) {
        return encoder.encode(raw);
    }

    @Transactional
    public Map<String, Object> login(String username, String password) {
        User user = users.findByUsername(username)
                .filter(found -> encoder.matches(password, found.getPasswordHash()))
                .orElseThrow(() -> new BusinessException(HttpStatus.UNAUTHORIZED, "用户名或密码错误"));
        String token = UUID.randomUUID().toString().replace("-", "");
        tokens.save(new AuthToken(token, user.getId(), LocalDateTime.now().plusHours(ttlHours)));
        return Map.of("token", token, "user", profile(user));
    }

    public Optional<User> authenticate(String token) {
        return tokens.findById(token)
                .filter(found -> found.getExpiresAt().isAfter(LocalDateTime.now()))
                .flatMap(found -> users.findById(found.getUserId()));
    }

    @Transactional
    public void logout(String token) {
        tokens.deleteById(token);
    }

    public static Map<String, Object> profile(User user) {
        return Map.of(
                "id", user.getId(),
                "username", user.getUsername(),
                "displayName", user.getDisplayName(),
                "role", user.getRole());
    }
}
