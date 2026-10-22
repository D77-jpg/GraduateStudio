<script setup>
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { request, setToken } from "../api.js";

const router = useRouter();
const route = useRoute();
const username = ref("");
const password = ref("");
const error = ref("");
const loading = ref(false);

async function submit() {
  error.value = "";
  loading.value = true;
  try {
    const data = await request("/api/auth/login", {
      method: "POST",
      body: { username: username.value, password: password.value },
    });
    setToken(data.token);
    router.push(typeof route.query.redirect === "string" ? route.query.redirect : "/");
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-page">
    <form class="card login-card" @submit.prevent="submit">
      <h1>毕业设计系统 · 登录</h1>
      <label>用户名<input v-model="username" autocomplete="username" required /></label>
      <label>密码<input v-model="password" type="password" autocomplete="current-password" required /></label>
      <p v-if="error" class="error">{{ error }}</p>
      <button type="submit" :disabled="loading">{{ loading ? "登录中…" : "登录" }}</button>
      <p class="hint">演示账号：admin / Admin@123，student / Student@123</p>
    </form>
  </div>
</template>
