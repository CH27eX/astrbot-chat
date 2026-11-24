import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ConnectScreen from "./components/ConnectScreen";
import ErrorBoundary from "./components/ErrorBoundary";
import { isNativeShell, readConnection } from "./core/connection";
import { applyPrefs, readPrefs } from "./core/prefs";
import { registerServiceWorker } from "./core/pwa";
import { installViewportFix } from "./core/viewport";
import "./styles.css";

// 挂载前先把主题/强调色/字号/圆角套到 <html> 上：`:root` 默认是深色，
// 等 App 的 effect 跑就晚了，浅色用户会先看到一帧深色。
applyPrefs(readPrefs());

registerServiceWorker();

// 手机软键盘：算一次键盘遮挡高度写进 --kb-inset（老 WebView 的兜底，见 core/viewport.ts）
installViewportFix();

// 套壳（Capacitor）第一次打开时还没有电脑地址：先给「连接电脑」页，
// 连上之后 reload，endpoint.ts 才会读到新地址（它是模块级常量）。
const nativeShell = isNativeShell();
const shellNeedsConnect = nativeShell && !readConnection();

// 渲染异常只该毁掉出问题的那一块，不该把整个 root 卸载掉（手机上就是全黑）。
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {shellNeedsConnect ? (
        <ConnectScreen onConnected={() => window.location.reload()} />
      ) : (
        <App />
      )}
    </ErrorBoundary>
  </React.StrictMode>,
);

// 冷启动骨架（index.html 里内联的那块）在这里退场：等首帧画出来再淡出，
// 否则手机上会先看到一帧白底再看到界面（冷启动那一下最明显）。
const splash = document.getElementById("boot-splash");
if (splash) {
  requestAnimationFrame(() => {
    splash.classList.add("boot-done");
    window.setTimeout(() => splash.remove(), 220);
  });
}

