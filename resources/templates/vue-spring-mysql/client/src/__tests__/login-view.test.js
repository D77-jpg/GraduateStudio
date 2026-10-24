import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import LoginView from "../views/LoginView.vue";

describe("LoginView", () => {
  it("renders the login form", async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: LoginView }] });
    router.push("/");
    await router.isReady();
    const wrapper = mount(LoginView, { global: { plugins: [router] } });
    expect(wrapper.text()).toContain("登录");
    expect(wrapper.findAll("input")).toHaveLength(2);
  });
});
