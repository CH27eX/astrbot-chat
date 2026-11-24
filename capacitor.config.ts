import type { CapacitorConfig } from "@capacitor/cli";

/**
 * 手机端套壳（Android）。设计见 docs/手机套壳与UI-方案.md。
 *
 * 关键点：
 * - webDir 直接吃现有的 `dist`（和桌面壳同一套前端）；
 * - androidScheme 用 https：App 内页面是安全上下文（录音 / PWA API / randomUUID 都可用）；
 * - 不开 allowMixedContent：数据只走 https（PC 上的 BFF 8789，自签 CA 由 App 内置信任）。
 * - 首屏「连接电脑」由前端自己处理（Capacitor 的 Preferences 存地址），不在这里写死。
 */
const config: CapacitorConfig = {
  appId: "com.astrbot.chat",
  appName: "AstrBot Chat",
  webDir: "dist",
  android: {
    allowMixedContent: false,
  },
  server: {
    androidScheme: "https",
  },
};

export default config;
