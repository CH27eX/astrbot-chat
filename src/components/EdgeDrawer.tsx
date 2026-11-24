import { useRef, useState } from "react";
import { ChevronRight, Info, Link2, Moon, Settings, Sun, Bell } from "lucide-react";

export interface EdgeDrawerProps {
  botName: string;
  status: "checking" | "online" | "offline";
  theme: "dark" | "light";
  notifications: boolean;
  version: string;
  native: boolean;
  /** 受控开关：系统返回键要能先关掉抽屉，所以状态提到 App 里 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
  onToggleNotifications: () => void;
  onSwitchComputer: () => void;
}

/**
 * 手机端「设置抽屉」：从左边缘往右滑呼出，样式参考手机 QQ 的设置页——
 * 顶部是账号卡片，下面是分组列表（每组一行标题 + 若干行：图标 / 文字 / 右侧 chevron）。
 *
 * 宽度按 QQ 的比例走（屏宽 84%，封顶 320px），跟手拖动时实时位移，
 * 松手按「是否过半」决定开还是合。
 *
 * 桌面端不挂这个组件（桌面有侧栏和设置弹层）。
 */
export default function EdgeDrawer(props: EdgeDrawerProps) {
  const { open, onOpenChange } = props;
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startX = useRef<number | null>(null);
  const moved = useRef(false);
  const widthRef = useRef(300);
  const asideRef = useRef<HTMLElement>(null);

  const edge = 26; // 左边缘感应区

  const onTouchStart = (event: React.TouchEvent) => {
    const touch = event.touches[0];
    if (!touch) return;
    if (open) return;
    if (touch.clientX > edge) return;
    widthRef.current = asideRef.current?.offsetWidth ?? 300;
    startX.current = touch.clientX;
    moved.current = false;
    setDragging(true);
  };

  const onTouchMove = (event: React.TouchEvent) => {
    if (startX.current === null) return;
    const touch = event.touches[0];
    if (!touch) return;
    const dx = Math.max(0, Math.min(widthRef.current, touch.clientX - startX.current));
    if (dx > 4) moved.current = true;
    setDragX(dx);
  };

  const onTouchEnd = () => {
    const dx = dragX;
    startX.current = null;
    setDragging(false);
    setDragX(0);
    // 划过 30% 或快速划一下都算「要开」；纯点一下边缘（<4px）不弹抽屉
    if (moved.current && dx > widthRef.current * 0.3) onOpenChange(true);
  };

  const statusText =
    props.status === "online" ? "已连接" : props.status === "checking" ? "连接中…" : "未连接";

  const close = () => onOpenChange(false);

  const progress = open ? 1 : Math.min(1, dragX / (widthRef.current || 300));

  return (
    <>
      {/* 左侧屏幕边缘的感应层：只有它监听手势，不挡页面点击 */}
      <div
        className="edge-hit"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={open ? { pointerEvents: "none" } : undefined}
      />

      {/* 遮罩跟着手指淡入，不再是「一开就全黑」 */}
      <div
        className={`drawer-mask ${open ? "open" : ""} ${dragging ? "dragging" : ""}`}
        style={{ opacity: progress }}
        onClick={close}
        aria-hidden={progress === 0}
      />

      <aside
        ref={asideRef}
        className={`edge-drawer ${open ? "open" : ""} ${dragging ? "dragging" : ""}`}
        style={
          !open && dragX > 0
            ? { transform: `translateX(${dragX - widthRef.current}px)` }
            : undefined
        }
        aria-hidden={!open}
      >
        <div className="drawer-account">
          <div className="drawer-avatar">{props.botName.slice(0, 1)}</div>
          <div className="drawer-account-text">
            <strong>{props.botName}</strong>
            <small>
              <span className={`status-dot ${props.status}`} />
              {statusText}
            </small>
          </div>
        </div>

        <div className="drawer-group">
          <div className="drawer-group-title">通用</div>
          <button className="drawer-row" onClick={() => { close(); props.onOpenSettings(); }}>
            <span className="drawer-icon"><Settings size={17} /></span>
            <span className="drawer-label">设置</span>
            <ChevronRight size={16} className="drawer-chev" />
          </button>
          {props.native && (
            <button className="drawer-row" onClick={() => { close(); props.onSwitchComputer(); }}>
              <span className="drawer-icon"><Link2 size={17} /></span>
              <span className="drawer-label">换一台电脑</span>
              <ChevronRight size={16} className="drawer-chev" />
            </button>
          )}
        </div>

        <div className="drawer-group">
          <div className="drawer-group-title">外观与提醒</div>
          <button className="drawer-row" onClick={props.onToggleTheme}>
            <span className="drawer-icon">
              {props.theme === "dark" ? <Moon size={17} /> : <Sun size={17} />}
            </span>
            <span className="drawer-label">深色模式</span>
            <span className={`drawer-switch ${props.theme === "dark" ? "on" : ""}`} />
          </button>
          <button className="drawer-row" onClick={props.onToggleNotifications}>
            <span className="drawer-icon"><Bell size={17} /></span>
            <span className="drawer-label">新消息提醒</span>
            <span className={`drawer-switch ${props.notifications ? "on" : ""}`} />
          </button>
        </div>

        <div className="drawer-group">
          <div className="drawer-group-title">关于</div>
          <div className="drawer-row static">
            <span className="drawer-icon"><Info size={17} /></span>
            <span className="drawer-label">版本</span>
            <span className="drawer-value">{props.version}</span>
          </div>
        </div>

        <p className="drawer-foot">AstrBot Chat · 本地优先，数据不出你的电脑</p>
      </aside>
    </>
  );
}
