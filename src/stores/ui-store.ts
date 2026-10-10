import { create } from "zustand";

/** 应用壳层的 UI 状态(侧边栏抽屉、顶栏页面标题)。与业务数据无关。 */

interface UiState {
  pageTitle: string;
  mobileNavOpen: boolean;
  setPageTitle: (title: string) => void;
  setMobileNavOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  pageTitle: "",
  mobileNavOpen: false,
  setPageTitle: (title) => set({ pageTitle: title }),
  setMobileNavOpen: (open) => set({ mobileNavOpen: open }),
}));
