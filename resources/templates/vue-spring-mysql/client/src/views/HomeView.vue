<script setup>
import { onMounted, ref } from "vue";
import { request } from "../api.js";

const user = ref(null);
const error = ref("");
onMounted(async () => {
  try {
    user.value = await request("/api/auth/me");
  } catch (e) {
    error.value = e.message;
  }
});
</script>

<template>
  <section>
    <h1>欢迎{{ user ? `，${user.displayName}` : "" }}</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <div class="card">
      <p>这是系统首页。业务模块完成后会在上方导航中出现对应入口。</p>
      <p v-if="user">当前账号：{{ user.username }}（{{ user.role === "ADMIN" ? "管理员" : "普通用户" }}）</p>
    </div>
  </section>
</template>
