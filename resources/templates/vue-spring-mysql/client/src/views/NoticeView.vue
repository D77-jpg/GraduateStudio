<script setup>
import { onMounted, ref } from "vue";
import { request } from "../api.js";

// 示例纵切：列表 + 发布表单。新模块页面照此结构实现。
const notices = ref([]);
const me = ref(null);
const title = ref("");
const content = ref("");
const error = ref("");
const loading = ref(true);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [user, list] = await Promise.all([request("/api/auth/me"), request("/api/notices")]);
    me.value = user;
    notices.value = list;
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function publish() {
  error.value = "";
  try {
    await request("/api/notices", { method: "POST", body: { title: title.value, content: content.value } });
    title.value = "";
    content.value = "";
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

async function remove(id) {
  if (!confirm("确定删除这条公告？")) return;
  try {
    await request(`/api/notices/${id}`, { method: "DELETE" });
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

onMounted(load);
</script>

<template>
  <section>
    <h1>公告管理</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <form v-if="me && me.role === 'ADMIN'" class="card form" @submit.prevent="publish">
      <label>标题<input v-model="title" maxlength="200" required /></label>
      <label>内容<textarea v-model="content" rows="3" required /></label>
      <button type="submit">发布公告</button>
    </form>
    <p v-if="loading">加载中…</p>
    <table v-else class="table">
      <thead>
        <tr><th>标题</th><th>内容</th><th>发布时间</th><th v-if="me && me.role === 'ADMIN'">操作</th></tr>
      </thead>
      <tbody>
        <tr v-for="n in notices" :key="n.id">
          <td>{{ n.title }}</td>
          <td>{{ n.content }}</td>
          <td>{{ n.createdAt }}</td>
          <td v-if="me && me.role === 'ADMIN'"><button class="link" @click="remove(n.id)">删除</button></td>
        </tr>
        <tr v-if="!notices.length"><td colspan="4" class="muted">暂无公告</td></tr>
      </tbody>
    </table>
  </section>
</template>
