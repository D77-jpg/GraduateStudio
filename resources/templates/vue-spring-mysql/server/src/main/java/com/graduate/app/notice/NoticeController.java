package com.graduate.app.notice;

import com.graduate.app.auth.AuthInterceptor;
import com.graduate.app.auth.User;
import com.graduate.app.common.ApiResponse;
import com.graduate.app.common.BusinessException;
import jakarta.validation.Valid;
import java.util.List;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/notices")
public class NoticeController {
    private final NoticeRepository notices;

    public NoticeController(NoticeRepository notices) {
        this.notices = notices;
    }

    @GetMapping
    public ApiResponse<List<Notice>> list() {
        return ApiResponse.ok(notices.findAllByOrderByIdDesc());
    }

    @GetMapping("/{id}")
    public ApiResponse<Notice> get(@PathVariable Long id) {
        return ApiResponse.ok(notices.findById(id).orElseThrow(() -> BusinessException.notFound("公告")));
    }

    @PostMapping
    public ApiResponse<Notice> create(@RequestAttribute(AuthInterceptor.CURRENT_USER) User user,
                                      @Valid @RequestBody NoticeRequest request) {
        user.requireRole("ADMIN");
        return ApiResponse.ok(notices.save(new Notice(request.title(), request.content(), user.getId())));
    }

    @DeleteMapping("/{id}")
    public ApiResponse<Void> delete(@RequestAttribute(AuthInterceptor.CURRENT_USER) User user, @PathVariable Long id) {
        user.requireRole("ADMIN");
        if (!notices.existsById(id)) throw BusinessException.notFound("公告");
        notices.deleteById(id);
        return ApiResponse.ok(null);
    }
}
