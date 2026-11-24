import {
  Bell,
  Brain,
  Check,
  ChevronLeft,
  ChevronRight,
  Info,
  Link2,
  Moon,
  Palette,
  Paintbrush,
  Settings2,
  Image as ImageIcon,
  Type,
  UserRound,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import { initialOf, readAvatarImage, readChatBackground } from "../core/images";
import { MAX_CHAT_BG, type Accent, type ChatBgBlur, type ChatBgDim, type ChatBgItem, type Density, type FontScale, type RadiusStyle } from "../core/prefs";
import { isNativeShell } from "../core/connection";
import { useEscape } from "../core/useEscape";
import { uid } from "../core/utils";
import type { SettingsDialogProps } from "./SettingsDialog";

const DENSITY_OPTIONS: { value: Density; label: string }[] = [
  { value: "comfortable", label: "舒适" },
  { value: "compact", label: "紧凑" },
];

const ACCENT_OPTIONS: { value: Accent; label: string }[] = [
  { value: "blue", label: "天蓝" },
  { value: "violet", label: "黛紫" },
  { value: "green", label: "青绿" },
  { value: "cyan", label: "湖蓝" },
  { value: "orange", label: "暖橙" },
  { value: "rose", label: "绯红" },
];

const FONT_SCALE_OPTIONS: { value: FontScale; label: string }[] = [
  { value: "s", label: "小" },
  { value: "m", label: "中" },
  { value: "l", label: "大" },
];

const RADIUS_OPTIONS: { value: RadiusStyle; label: string }[] = [
  { value: "sharp", label: "直角" },
  { value: "default", label: "默认" },
  { value: "round", label: "圆润" },
];

const CHAT_BG_DIM_OPTIONS: { value: ChatBgDim; label: string }[] = [
  { value: "light", label: "浅" },
  { value: "mid", label: "适中" },
  { value: "strong", label: "深" },
];

const CHAT_BG_BLUR_OPTIONS: { value: ChatBgBlur; label: string }[] = [
  { value: "off", label: "关" },
  { value: "soft", label: "轻" },
  { value: "strong", label: "强" },
];

type MobileSettingsProps = Pick<
  SettingsDialogProps,
  | "username"
  | "status"
  | "notifications"
  | "onToggleNotifications"
  | "density"
  | "onDensityChange"
  | "theme"
  | "onThemeChange"
  | "accent"
  | "onAccentChange"
  | "accentHex"
  | "onAccentHexChange"
  | "fontScale"
  | "onFontScaleChange"
  | "radius"
  | "onRadiusChange"
  | "botName"
  | "onBotNameChange"
  | "botAvatar"
  | "onBotAvatarChange"
  | "chatBgItems"
  | "chatBgActive"
  | "chatBgDim"
  | "chatBgBlur"
  | "onAddChatBg"
  | "onSelectChatBg"
  | "onRemoveChatBg"
  | "onChatBgDimChange"
  | "onChatBgBlurChange"
  | "sidebarBgActive"
  | "onSidebarBgChange"
  | "onSave"
  | "onClose"
> & {
  version: string;
  /** 换一台电脑（只有套壳里有意义） */
  onSwitchComputer?: () => void;
};

/**
 * 手机端设置：QQ 那种「全屏 + 分组列表」的页面，取代桌面弹层。
 *
 * 只放手机上用得上的项（API Key / 局域网 / 更新源这些桌面专属的不在这里），
 * 改了立刻生效——不需要「保存」；只有改用户名要显式保存（它会让会话列表重拉）。
 */
export default function MobileSettings(props: MobileSettingsProps) {
  const [name, setName] = useState(props.username);
  const avatarRef = useRef<HTMLInputElement>(null);
  const bgRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const native = isNativeShell();
  const nameChanged = name.trim() !== props.username.trim();
  /** 账号卡上的名字：机器人名字留空时回到产品名（和侧栏 / 抽屉同一套兜底） */
  const displayName = props.botName.trim() || "AstrBot";

  useEscape(props.onClose);

  const pickAvatar = async (file: File) => {
    setBusy("正在处理头像…");
    setError(null);
    try {
      props.onBotAvatarChange(await readAvatarImage(file));
    } catch (e) {
      setError(e instanceof Error ? e.message : "换头像失败");
    } finally {
      setBusy(null);
    }
  };

  const pickChatBg = async (files: File[]) => {
    setBusy("正在处理背景图…");
    setError(null);
    const room = Math.max(0, MAX_CHAT_BG - props.chatBgItems.length);
    const accepted = files.slice(0, room);
    const added: ChatBgItem[] = [];
    try {
      for (const file of accepted) {
        try {
          added.push({ id: uid(), ...(await readChatBackground(file)) });
        } catch (e) {
          setError(`${file.name || "图片"}：${e instanceof Error ? e.message : "处理失败"}`);
        }
      }
    } finally {
      setBusy(null);
    }
    if (added.length > 0) props.onAddChatBg(added);
  };

  const statusText =
    props.status === "online" ? "已连接" : props.status === "checking" ? "连接中…" : "未连接";

  return (
    <div className="ms">
      <header className="ms-head">
        <button className="icon-btn" onClick={props.onClose} title="返回" aria-label="返回">
          <ChevronLeft size={24} />
        </button>
        <h1>设置</h1>
      </header>

      <div className="ms-body">
        <div className="ms-account">
          <div className="ms-avatar">
            {props.botAvatar ? <img src={props.botAvatar} alt="" /> : initialOf(displayName)}
          </div>
          <div className="ms-account-text">
            <strong>{displayName}</strong>
            <small>
              <span className={`status-dot ${props.status}`} />
              {statusText}
            </small>
          </div>
        </div>

        <section className="ms-group">
          <div className="ms-group-title">通用</div>
          <div className="ms-card">
            <div className="ms-row">
              <span className="ms-icon"><UserRound size={16} /></span>
              <span className="ms-label">WebChat 用户名</span>
              <input
                className="ms-input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="astrbot"
                autoComplete="off"
                spellCheck={false}
              />
              {nameChanged && (
                <button className="ms-mini" onClick={() => props.onSave(name)}>
                  <Check size={14} />
                  保存
                </button>
              )}
            </div>
            <div className="ms-row static">
              <span className="ms-icon"><Settings2 size={16} /></span>
              <span className="ms-label">连接状态</span>
              <span className="ms-value">
                <span className={`status-dot ${props.status}`} />
                {statusText}
              </span>
            </div>
            {native && props.onSwitchComputer && (
              <button className="ms-row" onClick={props.onSwitchComputer}>
                <span className="ms-icon"><Link2 size={16} /></span>
                <span className="ms-label">换一台电脑</span>
                <ChevronRight size={16} className="ms-chev" />
              </button>
            )}
            <button className="ms-row" onClick={props.onToggleNotifications}>
              <span className="ms-icon"><Bell size={16} /></span>
              <span className="ms-label">新消息提醒</span>
              <span className={`drawer-switch ${props.notifications ? "on" : ""}`} />
            </button>
          </div>
          <p className="ms-note">用户名要和 AstrBot 身份桥的映射一致（当前 webchat:astrbot）。</p>
        </section>

        <section className="ms-group">
          <div className="ms-group-title">外观</div>
          <div className="ms-card">
            <button className="ms-row" onClick={() => props.onThemeChange(props.theme === "dark" ? "light" : "dark")}>
              <span className="ms-icon"><Moon size={16} /></span>
              <span className="ms-label">深色模式</span>
              <span className={`drawer-switch ${props.theme === "dark" ? "on" : ""}`} />
            </button>
            <div className="ms-row block">
              <span className="ms-icon"><Settings2 size={16} /></span>
              <span className="ms-label">信息密度</span>
              <div className="pill-group ms-pills">
                {DENSITY_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    className={`pill ${props.density === option.value ? "on" : ""}`}
                    onClick={() => props.onDensityChange(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="ms-row block">
              <span className="ms-icon"><Palette size={16} /></span>
              <span className="ms-label">强调色</span>
              <div className="swatch-group ms-swatches">
                {ACCENT_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`swatch ${props.accentHex ? "" : props.accent === option.value ? "on" : ""}`}
                    data-swatch={option.value}
                    onClick={() => props.onAccentChange(option.value)}
                    title={option.label}
                    aria-label={option.label}
                  />
                ))}
                <label
                  className={`swatch swatch-custom ${props.accentHex ? "on" : ""}`}
                  style={props.accentHex ? { background: props.accentHex } : undefined}
                  title="自定义颜色"
                >
                  <input
                    type="color"
                    value={props.accentHex || "#6ea8fe"}
                    onChange={(event) => props.onAccentHexChange(event.target.value)}
                    aria-label="自定义强调色"
                  />
                </label>
              </div>
            </div>
            <div className="ms-row block">
              <span className="ms-icon"><Type size={16} /></span>
              <span className="ms-label">字号</span>
              <div className="pill-group ms-pills">
                {FONT_SCALE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    className={`pill ${props.fontScale === option.value ? "on" : ""}`}
                    onClick={() => props.onFontScaleChange(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="ms-row block">
              <span className="ms-icon"><Paintbrush size={16} /></span>
              <span className="ms-label">圆角</span>
              <div className="pill-group ms-pills">
                {RADIUS_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    className={`pill ${props.radius === option.value ? "on" : ""}`}
                    onClick={() => props.onRadiusChange(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="ms-group">
          <div className="ms-group-title">侧栏背景</div>
          <div className="ms-card">
            <div className="ms-row block">
              <span className="ms-icon"><ImageIcon size={16} /></span>
              <span className="ms-label">会话列表单独一张</span>
              <div className="bg-grid ms-bg-grid">
                <button
                  type="button"
                  className={`bg-add ${props.sidebarBgActive === "" ? "on" : ""}`}
                  onClick={() => props.onSidebarBgChange("")}
                >
                  不使用
                </button>
                {props.chatBgItems.map((item) => (
                  <div
                    key={item.id}
                    className={`bg-item ${props.sidebarBgActive === item.id ? "on" : ""}`}
                  >
                    <button
                      type="button"
                      className="bg-pick"
                      onClick={() => props.onSidebarBgChange(item.id)}
                      aria-label="用这张当侧栏背景"
                    >
                      <img src={item.image} alt="" />
                    </button>
                  </div>
                ))}
              </div>
              <small className="ms-hint">
                和「聊天背景」分开：聊天区不铺背景时，侧栏也可以单独铺一张。
              </small>
            </div>
          </div>
        </section>
        <section className="ms-group">
          <div className="ms-group-title">聊天背景</div>
          <div className="ms-card">
            <div className="ms-row block">
              <span className="ms-icon"><Brain size={16} /></span>
              <span className="ms-label">图库</span>
              <div className="bg-grid ms-bg-grid">
                {props.chatBgItems.map((item) => (
                  <div key={item.id} className={`bg-item ${props.chatBgActive === item.id ? "on" : ""}`}>
                    <button
                      type="button"
                      className="bg-pick"
                      onClick={() => props.onSelectChatBg(item.id)}
                      aria-label="用这张当背景"
                    >
                      <img src={item.image} alt="" />
                    </button>
                    <button
                      type="button"
                      className="bg-del"
                      onClick={() => props.onRemoveChatBg(item.id)}
                      aria-label="删除这张背景图"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="bg-add"
                  onClick={() => bgRef.current?.click()}
                  disabled={props.chatBgItems.length >= MAX_CHAT_BG}
                >
                  ＋ 添加
                </button>
              </div>
            </div>
            <div className="ms-row block">
              <span className="ms-icon"><Moon size={16} /></span>
              <span className="ms-label">明暗</span>
              <div className="pill-group ms-pills">
                {CHAT_BG_DIM_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    className={`pill ${props.chatBgDim === option.value ? "on" : ""}`}
                    onClick={() => props.onChatBgDimChange(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="ms-row block">
              <span className="ms-icon"><Paintbrush size={16} /></span>
              <span className="ms-label">虚化</span>
              <div className="pill-group ms-pills">
                {CHAT_BG_BLUR_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    className={`pill ${props.chatBgBlur === option.value ? "on" : ""}`}
                    onClick={() => props.onChatBgBlurChange(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="ms-group">
          <div className="ms-group-title">机器人</div>
          <div className="ms-card">
            <div className="ms-row">
              <span className="ms-icon"><UserRound size={16} /></span>
              <span className="ms-label">名字</span>
              <input
                className="ms-input"
                value={props.botName}
                onChange={(event) => props.onBotNameChange(event.target.value)}
                placeholder="AstrBot"
                maxLength={24}
                autoComplete="off"
              />
            </div>
            <div className="ms-row">
              <span className="ms-icon"><UserRound size={16} /></span>
              <span className="ms-label">头像</span>
              <button className="ms-mini" onClick={() => avatarRef.current?.click()} disabled={busy !== null}>
                选图片
              </button>
              {props.botAvatar && (
                <button
                  className="ms-mini ghost"
                  onClick={() => props.onBotAvatarChange("")}
                >
                  默认
                </button>
              )}
            </div>
          </div>
          <p className="ms-note">名字和头像只影响这台手机上的显示。</p>
        </section>

        <section className="ms-group">
          <div className="ms-group-title">关于</div>
          <div className="ms-card">
            <div className="ms-row static">
              <span className="ms-icon"><Info size={16} /></span>
              <span className="ms-label">版本</span>
              <span className="ms-value">{props.version}</span>
            </div>
          </div>
          <p className="ms-note">AstrBot Chat · 本地优先，数据不出你的电脑</p>
        </section>

        {(busy || error) && (
          <p className={`ms-note ${error ? "warn" : ""}`}>{error ?? busy}</p>
        )}
        <div className="ms-foot" />
      </div>

      <input
        ref={avatarRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void pickAvatar(file);
          event.target.value = "";
        }}
      />
      <input
        ref={bgRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length > 0) void pickChatBg(files);
          event.target.value = "";
        }}
      />
    </div>
  );
}



