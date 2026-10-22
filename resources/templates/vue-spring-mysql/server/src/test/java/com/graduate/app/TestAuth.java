package com.graduate.app;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

/** 测试辅助：登录并返回 "Bearer <token>"，用于 header("Authorization", ...)。 */
public final class TestAuth {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private TestAuth() {
    }

    public static String login(MockMvc mockMvc, String username, String password) throws Exception {
        String body = mockMvc.perform(post("/api/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(MAPPER.writeValueAsString(java.util.Map.of("username", username, "password", password))))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
        return "Bearer " + MAPPER.readTree(body).path("data").path("token").asText();
    }
}
