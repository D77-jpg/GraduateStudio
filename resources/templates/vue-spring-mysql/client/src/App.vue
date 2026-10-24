<script setup>
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { getToken, request, setToken } from "./api.js";

const route = useRoute();
const router = useRouter();
const user = ref(null);
const loggedIn = computed(() => route.name !== "login" && !!getToken());

async function loadUser() {
  if (!getToken() || route.name === "login") {
    user.value = null;
    return;
  }
  try {
    user.value = await request("/api/auth/me");
  } catch {
    user.value = null;
  }
}
watch(() => route.fullPath, loadUser, { immediate: true });

async function logout() {
  try {
    await request("/api/auth/logout", { method: "POST" });
  } catch {
    /* 令牌可能已失效 */
  }
  setToken(null);
  router.push("/login");
}
</script>

<template>
  <div class="layout">
    <header v-if="loggedIn" class="topbar">
      <strong class="brand">毕业设计系统</strong>
      <nav>
        <RouterLink to="/">首页</RouterLink>
        <RouterLink to="/notices">公告管理</RouterLink>
      </nav>
      <span class="spacer" />
      <span v-if="user" class="who">{{ user.displayName }}（{{ user.role === "ADMIN" ? "管理员" : "用户" }}）</span>
      <button class="link" @click="logout">退出</button>
    </header>
    <main class="content">
      <RouterView />
    </main>
  </div>
</template>
