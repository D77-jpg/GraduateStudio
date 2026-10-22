package com.graduate.app.auth;

import com.graduate.app.common.ApiResponse;
import jakarta.validation.Valid;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/auth")
public class AuthController {
    private final AuthService authService;

    public AuthController(AuthService authService) {
        this.authService = authService;
    }

    @PostMapping("/login")
    public ApiResponse<Map<String, Object>> login(@Valid @RequestBody LoginRequest request) {
        return ApiResponse.ok(authService.login(request.username(), request.password()));
    }

    @GetMapping("/me")
    public ApiResponse<Map<String, Object>> me(@RequestAttribute(AuthInterceptor.CURRENT_USER) User user) {
        return ApiResponse.ok(AuthService.profile(user));
    }

    @PostMapping("/logout")
    public ApiResponse<Void> logout(@RequestAttribute(AuthInterceptor.CURRENT_TOKEN) String token) {
        authService.logout(token);
        return ApiResponse.ok(null);
    }
}
