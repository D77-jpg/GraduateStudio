package com.graduate.app.notice;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record NoticeRequest(
        @NotBlank(message = "不能为空") @Size(max = 200, message = "不能超过200字") String title,
        @NotBlank(message = "不能为空") String content) {
}
