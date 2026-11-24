import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * 最外层兜底：任何一处渲染抛异常（包括写在 `setMessages(prev => ...)` 里的
 * updater —— React 是在 render 阶段执行它的），都不该让整屏变黑。
 *
 * 背景：2026-11-18 手机端「发一条消息就整屏黑」就是 `crypto.randomUUID`
 * 在非安全上下文不存在 → updater 里抛 TypeError → 没有 ErrorBoundary →
 * React 19 直接把 root 卸载 → 只剩 body 背景色。见 docs/交接-2026-11-18-手机端.md §3。
 *
 * 这里只兜住「渲染」这一类错误：事件处理函数里的异常 React 不会转给边界，
 * 所以业务代码该 try/catch 的还得 try/catch。
 */
interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  /** 变更时连同 children 一起重挂，避免「重试」后又撞同一个坏 state */
  attempt: number;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> | null {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 手机上没法开 DevTools：把栈打到控制台，必要时让用户截图
    console.error("[astrbot-chat] 渲染失败：", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) {
      return <div key={this.state.attempt} style={{ display: "contents" }}>{this.props.children}</div>;
    }

    return (
      <div className="crash-screen" role="alert">
        <div className="crash-card">
          <h2>这一屏渲染失败了</h2>
          <p>
            聊天记录还在，刷新后能接着用。如果反复出现，把下面这段发给我：
          </p>
          <pre className="crash-detail">
            {error.name}: {error.message}
          </pre>
          <div className="crash-actions">
            <button
              type="button"
              className="primary-btn"
              onClick={() => this.setState((prev) => ({ error: null, attempt: prev.attempt + 1 }))}
            >
              重试
            </button>
            <button type="button" className="ghost-btn" onClick={() => window.location.reload()}>
              重新加载
            </button>
          </div>
        </div>
      </div>
    );
  }
}
