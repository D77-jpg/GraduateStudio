package com.graduate.app.common;

/** 统一响应：{"code":0,"message":"ok","data":...}；code 非 0 表示失败（通常等于 HTTP 状态码）。 */
public record ApiResponse<T>(int code, String message, T data) {
    public static <T> ApiResponse<T> ok(T data) {
        return new ApiResponse<>(0, "ok", data);
    }

    public static <T> ApiResponse<T> fail(int code, String message) {
        return new ApiResponse<>(code, message, null);
    }
}
