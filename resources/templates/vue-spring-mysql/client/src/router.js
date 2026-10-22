import { createRouter, createWebHistory } from "vue-router";
import { getToken } from "./api.js";
import LoginView from "./views/LoginView.vue";
import HomeView from "./views/HomeView.vue";
import NoticeView from "./views/NoticeView.vue";

// 新页面：在这里注册（需要登录的加 meta.requiresAuth），并在 App.vue 导航里加入口。
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", name: "login", component: LoginView },
    { path: "/", name: "home", component: HomeView, meta: { requiresAuth: true } },
    { path: "/notices", name: "notices", component: NoticeView, meta: { requiresAuth: true } },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

router.beforeEach((to) => {
  if (to.meta.requiresAuth && !getToken()) return { name: "login", query: { redirect: to.fullPath } };
  return true;
});

export default router;
