package com.graduate.app.common;

import org.springframework.http.HttpStatus;

/** 业务异常：携带 HTTP 状态码，由 GlobalExceptionHandler 转为统一响应。 */
public class BusinessException extends RuntimeException {
    private final HttpStatus status;

    public BusinessException(HttpStatus status, String message) {
        super(message);
        this.status = status;
    }

    public HttpStatus getStatus() {
        return status;
    }

    public static BusinessException notFound(String what) {
        return new BusinessException(HttpStatus.NOT_FOUND, what + "不存在");
    }
}
