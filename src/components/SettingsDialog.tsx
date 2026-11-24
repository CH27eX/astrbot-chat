import { RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useEscape } from "../core/useEscape";
import { initialOf, readAvatarImage, readChatBackground } from "../core/images";
import {
  type Accent,
  type ChatBgBlur,
  type ChatBgDim,
  type ChatBgItem,
  type Density,
  type FontScale,
  type Prefs,
  type RadiusStyle,
  type Theme,
  MAX_CHAT_BG,
} from "../core/prefs";
import {
  buildConfigBundle,
  configBundleFileName,
  downloadConfigFile,
  parseConfigBundle,
  serializeConfigBundle,
} from "../core/config-bundle";
import { probeKey, type KeyProbe } from "../core/transport";
import { uid } from "../core/utils";
import { readBffStatus, readApiKey, restartBff, writeApiKey, type BffStatus } from "../desktop/bff";
import { readLanInfo, resetLanPairing, setLanAccess, setLanRemoteBase, type LanInfo } from "../desktop/lan";
import { PairingCode } from "./PairingCode";
import { QrCanvas } from "./QrCode";
import {
  checkForUpdate,
  DEFAULT_DESKTOP_SETTINGS,
  exportDiagnostics,
  installUpdate,
  isAutostartEnabled,
  isDesktop,
  readDesktopSettings,
  setAutostart,
  writeDesktopSettings,
  type CloseBehavior,
  type DesktopSettings,
  type UpdateCheck,
} from "../desktop/bridge";

export interface SettingsDialogProps {
  username: string;
  status: "checking" | "online" | "offline";
  baseUrl: string;
  notifications: boolean;
  /** 信息密度：舒适 / 紧凑 */
  density: Density;
  onDensityChange: (density: Density) => void;
  /** 主题：深色 / 浅色 */
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  /** 强调色 / 字号档 / 圆角档 */
  accent: Accent;
  onAccentChange: (accent: Accent) => void;
  /** 自定义强调色（"#rrggbb"）；空 = 用预设 */
  accentHex: string;
  onAccentHexChange: (hex: string) => void;
  fontScale: FontScale;
  onFontScaleChange: (fontScale: FontScale) => void;
  radius: RadiusStyle;
  onRadiusChange: (radius: RadiusStyle) => void;
  /** 机器人：名字 + 头像（只影响本机显示） */
  botName: string;
  onBotNameChange: (name: string) => void;
  botAvatar: string;
  onBotAvatarChange: (url: string) => void;
  /** 背景图库：可以放多张，点缩略图切换 */
  chatBgItems: ChatBgItem[];
  chatBgActive: string;
  chatBgDim: ChatBgDim;
  chatBgBlur: ChatBgBlur;
  onAddChatBg: (items: ChatBgItem[]) => void;
  onSelectChatBg: (id: string) => void;
  onRemoveChatBg: (id: string) => void;
  onChatBgDimChange: (dim: ChatBgDim) => void;
  onChatBgBlurChange: (blur: ChatBgBlur) => void;
  /** 侧栏（会话列表）单独挑一张背景；"" = 不铺 */
  sidebarBgActive: string;
  onSidebarBgChange: (id: string) => void;
  /** 导入配置时整份替换偏好（外观 / 机器人 / 背景一起回来） */
  onReplacePrefs: (prefs: Prefs) => void;
  /** 可选的 webchat_admin 插件是否装好 */
  adminAvailable: boolean;
  adminVersion?: string;
  onSave: (username: string) => void;
  onClose: () => void;
  onRetry: () => void;
  onToggleNotifications: () => void;
  onTestNotification: () => void;
  onTestProactive: () => void;
}

const CLOSE_OPTIONS: { value: CloseBehavior; label: string }[] = [
  { value: "ask", label: "每次询问" },
  { value: "tray", label: "最小化到托盘" },
  { value: "exit", label: "直接退出" },
];

const DENSITY_OPTIONS: { value: Density; label: string; hint: string }[] = [
  { value: "comfortable", label: "舒适", hint: "字号大、留白多" },
  { value: "compact", label: "紧凑", hint: "一屏多看几条" },
];

const THEME_OPTIONS: { value: Theme; label: string; hint: string }[] = [
  { value: "dark", label: "深色", hint: "默认，夜里不刺眼" },
  { value: "light", label: "浅色", hint: "白天、投屏时更清楚" },
];

const ACCENT_OPTIONS: { value: Accent; label: string }[] = [
  { value: "blue", label: "天蓝（默认）" },
  { value: "violet", label: "黛紫" },
  { value: "green", label: "青绿" },
  { value: "cyan", label: "湖蓝" },
  { value: "orange", label: "暖橙" },
  { value: "rose", label: "绯红" },
];

const FONT_SCALE_OPTIONS: { value: FontScale; label: string; hint: string }[] = [
  { value: "s", label: "小", hint: "正文 ≈13.5px、元信息 ≈10.8px" },
  { value: "m", label: "中", hint: "默认；正文 15px、元信息 12px" },
  { value: "l", label: "大", hint: "正文 ≈17px、元信息 ≈13.6px" },
];

const CHAT_BG_DIM_OPTIONS: { value: ChatBgDim; label: string; hint: string }[] = [
  { value: "light", label: "浅", hint: "图露得多，字可能费劲" },
  { value: "mid", label: "适中", hint: "默认" },
  { value: "strong", label: "深", hint: "图压得暗，字最清楚" },
];

const CHAT_BG_BLUR_OPTIONS: { value: ChatBgBlur; label: string; hint: string }[] = [
  { value: "off", label: "关", hint: "原图直出" },
  { value: "soft", label: "轻", hint: "轻微虚化，看得清画面" },
  { value: "strong", label: "强", hint: "糊成色块，最不抢字" },
];

const RADIUS_OPTIONS: { value: RadiusStyle; label: string; hint: string }[] = [
  { value: "sharp", label: "直角", hint: "圆角收紧，看着更利落" },
  { value: "default", label: "默认", hint: "现在的圆角" },
  { value: "round", label: "圆润", hint: "圆角放大，气泡更软" },
];

type SettingsTab = "general" | "appearance" | "bot" | "desktop";

/** 分页：设置项多了以后一屏放不下，按「常改 / 外观 / 机器人 / 桌面」分开 */
const TAB_ITEMS: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "通用" },
  { id: "appearance", label: "外观" },
  { id: "bot", label: "机器人" },
  { id: "desktop", label: "桌面" },
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 远程地址是不是「https 但没写端口」。
 *
 * 手机 APK 的连接页会把没有端口的 https 链接补成 `:8789`（`core/connection.ts`
 * 的老约定），而 URL 规范又会把显式 `:443` 吃掉 —— 所以 B 方案的地址一律写成
 * `https://<机器>.<tailnet>.ts.net:8443`，少了端口 APK 就连不上。
 */
function remotePortMissing(base: string): boolean {
  if (!base) return false;
  try {
    const url = new URL(base);
    return url.protocol === "https:" && !url.port;
  } catch {
    return false;
  }
}

/** 把 Key 体检结果翻译成一句人话 */
function probeText(check: KeyProbe): string {
  if (!check.ok) return `连不上 BFF：${check.error ?? "未知错误"}`;
  const checks = check.checks ?? {};
  if (checks.chat === "bad-key") return "Key 无效（AstrBot 返回 401）";
  if (checks.chat === "missing-scope") return "Key 缺 chat scope";
  if (checks.chat !== "ok") return `chat 检查异常：${checks.chat ?? "无响应"}`;

  const missing: string[] = [];
  if (checks.plugin === "missing-scope") missing.push("plugin（记忆抽屉）");
  if (checks.file === "missing-scope") missing.push("file（图片/语音）");
  if (missing.length > 0) return `Key 可用；还缺 scope：${missing.join("、")}`;
  return "Key 可用：聊天 / 记忆 / 媒体都能用";
}

export default function SettingsDialog({
  username,
  status,
  baseUrl,
  notifications,
  density,
  onDensityChange,
  theme,
  onThemeChange,
  accent,
  onAccentChange,
  accentHex,
  onAccentHexChange,
  fontScale,
  onFontScaleChange,
  radius,
  onRadiusChange,
  botName,
  onBotNameChange,
  botAvatar,
  onBotAvatarChange,
  chatBgItems,
  chatBgActive,
  chatBgDim,
  chatBgBlur,
  onAddChatBg,
  onSelectChatBg,
  onRemoveChatBg,
  onChatBgDimChange,
  onChatBgBlurChange,
  sidebarBgActive,
  onSidebarBgChange,
  onReplacePrefs,
  adminAvailable,
  adminVersion,
  onSave,
  onClose,
  onRetry,
  onToggleNotifications,
  onTestNotification,
  onTestProactive,
}: SettingsDialogProps) {
  const [name, setName] = useState(username);
  const [tab, setTab] = useState<SettingsTab>("general");

  // 机器人头像 / 聊天背景：选图后先在浏览器里压成小图，再写进偏好。
  // 两条链路各自独立（各自的 busy / error），所以「恢复默认头像」永远碰不到背景图。
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const bgInputRef = useRef<HTMLInputElement>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [bgBusy, setBgBusy] = useState(false);
  const [bgProgress, setBgProgress] = useState<string | null>(null);
  const [bgError, setBgError] = useState<string | null>(null);

  // 备份 / 迁移：导出、导入一份不含 API Key 的 JSON
  const importInputRef = useRef<HTMLInputElement>(null);
  const [configBusy, setConfigBusy] = useState(false);
  const [configMessage, setConfigMessage] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  // 排障：一键诊断包（日志 + 环境信息，Key 已打码）
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagMessage, setDiagMessage] = useState<string | null>(null);
  const [diagError, setDiagError] = useState<string | null>(null);

  const desktop = isDesktop();
  const [desktopSettings, setDesktopSettings] = useState<DesktopSettings | null>(
    null,
  );
  const [autostart, setAutostartState] = useState(false);
  const [desktopError, setDesktopError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [keyRevealed, setKeyRevealed] = useState(false);
  const [keySaving, setKeySaving] = useState(false);
  const [keyMessage, setKeyMessage] = useState<string | null>(null);
  const [keyTesting, setKeyTesting] = useState(false);
  const [keyCheck, setKeyCheck] = useState<KeyProbe | null>(null);
  const [bff, setBff] = useState<BffStatus | null>(null);

  // AstrBot 地址（空 = 自动发现）
  const [astrbotUrl, setAstrbotUrl] = useState("");
  // AstrBot 数据目录（空 = 让 BFF 按平台猜；Linux/容器/非标准安装时填）
  const [astrbotDataDir, setAstrbotDataDir] = useState("");
  const [dataDirSaving, setDataDirSaving] = useState(false);
  const [dataDirMessage, setDataDirMessage] = useState<string | null>(null);
  const [urlSaving, setUrlSaving] = useState(false);
  const [urlMessage, setUrlMessage] = useState<string | null>(null);

  // 手机 / 局域网访问
  const [lan, setLan] = useState<LanInfo | null>(null);
  const [lanBusy, setLanBusy] = useState(false);
  const [lanMessage, setLanMessage] = useState<string | null>(null);
  /** 「重置配对」要点两下：第一下只是亮出确认行，免得手滑把家里手机全踢下线 */
  const [lanResetArmed, setLanResetArmed] = useState(false);
  /** 远程访问基址输入框（Tailscale Serve 之类）；空 = 用局域网地址 */
  const [remoteBase, setRemoteBase] = useState("");
  const [remoteBaseSaving, setRemoteBaseSaving] = useState(false);

  // 软件更新：更新源地址、检查结果、安装进度
  const [endpoint, setEndpoint] = useState("");
  const [endpointSaving, setEndpointSaving] = useState(false);
  const [endpointMessage, setEndpointMessage] = useState<string | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateCheck | null>(null);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  // 正在装更新时不响应 Esc，免得把进度面板关掉
  useEscape(onClose, !installing);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void (async () => {
      try {
        const [settings, enabled, storedKey, status] = await Promise.all([
          readDesktopSettings(),
          isAutostartEnabled(),
          readApiKey(),
          readBffStatus(),
        ]);
        if (cancelled) return;
        setDesktopSettings(settings);
        setAutostartState(enabled);
        setApiKey(storedKey);
        setBff(status);
        setEndpoint(settings.updateEndpoint);
        setAstrbotUrl(settings.astrbotUrl);
        setAstrbotDataDir(settings.astrbotDataDir);
      } catch (error) {
        if (!cancelled) setDesktopError(errorText(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  // 手机访问状态：单独拉，失败只影响这一块（例如外部 BFF 没有这个命令）
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void readLanInfo()
      .then((info) => {
        if (cancelled) return;
        setLan(info);
        setRemoteBase(info.remoteBase);
      })
      .catch((error) => {
        if (!cancelled) setLanMessage(errorText(error));
      });
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  const changeCloseBehavior = (closeBehavior: CloseBehavior) => {
    setDesktopError(null);
    setDesktopSettings((current) => ({
      ...(current ?? DEFAULT_DESKTOP_SETTINGS),
      closeBehavior,
    }));
    void writeDesktopSettings({ closeBehavior }).catch((error) =>
      setDesktopError(errorText(error)),
    );
  };

  const toggleAutostart = () => {
    const next = !autostart;
    setDesktopError(null);
    setAutostartState(next);
    void setAutostart(next).catch((error) => {
      setAutostartState(!next);
      setDesktopError(errorText(error));
    });
  };

  const toggleAutoLaunch = () => {
    const current = desktopSettings ?? DEFAULT_DESKTOP_SETTINGS;
    const next = !current.autoLaunchAstrbot;
    setDesktopError(null);
    setDesktopSettings({ ...current, autoLaunchAstrbot: next });
    void writeDesktopSettings({ autoLaunchAstrbot: next }).catch((error) =>
      setDesktopError(errorText(error)),
    );
  };

  const saveApiKey = async () => {
    setKeySaving(true);
    setDesktopError(null);
    setKeyMessage(null);
    try {
      await writeApiKey(apiKey);
      const status = await restartBff();
      setBff(status);
      setDesktopSettings((current) =>
        current
          ? { ...current, hasApiKey: apiKey.trim().length > 0, apiKeySource: apiKey.trim() ? "settings" : current.apiKeySource }
          : current,
      );
      setKeyMessage(
        status.running
          ? `BFF 已重启${status.pid ? `（pid ${status.pid}）` : ""}`
          : "BFF 没有起来，看看下面的错误",
      );
      onRetry();
    } catch (error) {
      setDesktopError(errorText(error));
    } finally {
      setKeySaving(false);
    }
  };

  /** 保存 AstrBot 地址（空 = 回到自动发现），然后重启 BFF 让它生效 */
  const saveAstrbotUrl = async () => {
    setUrlSaving(true);
    setDesktopError(null);
    setUrlMessage(null);
    try {
      await writeDesktopSettings({ astrbotUrl });
      const status = await restartBff();
      setBff(status);
      setUrlMessage(
        astrbotUrl.trim()
          ? "已保存，BFF 正在连这个地址"
          : "已清空，改回自动发现本机 AstrBot",
      );
      onRetry();
    } catch (error) {
      setUrlMessage(errorText(error));
    } finally {
      setUrlSaving(false);
    }
  };

  /** 保存 AstrBot 数据目录（空 = 让 BFF 自己猜），然后重启 BFF 让它生效 */
  const saveAstrbotDataDir = async () => {
    setDataDirSaving(true);
    setDesktopError(null);
    setDataDirMessage(null);
    try {
      await writeDesktopSettings({ astrbotDataDir });
      const status = await restartBff();
      setBff(status);
      setDataDirMessage(
        astrbotDataDir.trim()
          ? "已保存：BFF 会用这个目录找 data_v4.db"
          : "已清空：改回按平台自动查找",
      );
      onRetry();
    } catch (error) {
      setDataDirMessage(errorText(error));
    } finally {
      setDataDirSaving(false);
    }
  };

  /** 让 BFF 真打一次 AstrBot：区分「Key 错」和「scope 不够」 */
  const runKeyCheck = async () => {
    setKeyTesting(true);
    setKeyCheck(null);
    setKeyMessage(null);
    try {
      setKeyCheck(await probeKey());
    } catch (error) {
      setKeyMessage(errorText(error));
    } finally {
      setKeyTesting(false);
    }
  };

  const toggleLan = async () => {
    if (!lan) return;
    setLanBusy(true);
    setLanMessage(null);
    try {
      const next = await setLanAccess(!lan.enabled);
      setLan(next);
      if (!next.enabled) setLanResetArmed(false);
      setLanMessage(
        next.enabled
          ? "已开启：手机连同一个 Wi-Fi 后打开下面的链接"
          : "已关闭：BFF 回到只听本机",
      );
    } catch (error) {
      setLanMessage(errorText(error));
    } finally {
      setLanBusy(false);
    }
  };

  const copyLanUrl = async () => {
    if (!lan?.url) return;
    try {
      await navigator.clipboard.writeText(lan.url);
      setLanMessage("链接已复制");
    } catch {
      setLanMessage("复制失败，可以手动选中上面的地址");
    }
  };

  /** 第一步（装证书）的下载链接：手机上必须用 http 打开，https 这时候还不可信 */
  const copyCaUrl = async () => {
    if (!lan?.caUrl) return;
    try {
      await navigator.clipboard.writeText(lan.caUrl);
      setLanMessage("证书下载链接已复制，用手机浏览器打开");
    } catch {
      setLanMessage("复制失败，可以手动选中证书地址");
    }
  };

  /** 重置配对：换一把新令牌 + 重启 BFF，老二维码 / 老 cookie 全部失效 */
  const resetLan = async () => {
    setLanBusy(true);
    setLanMessage(null);
    try {
      const next = await resetLanPairing();
      setLan(next);
      setLanResetArmed(false);
      setLanMessage("已重置配对：老链接、老二维码都失效了，每台手机重新扫一次");
    } catch (error) {
      setLanMessage(errorText(error));
    } finally {
      setLanBusy(false);
    }
  };

  /** 保存 / 清除远程访问地址：只影响链接拼法，不重启 BFF */
  const saveRemoteBase = async (value: string) => {
    setRemoteBaseSaving(true);
    setLanMessage(null);
    try {
      const next = await setLanRemoteBase(value);
      setLan(next);
      setRemoteBase(next.remoteBase);
      setLanMessage(
        next.urlSource === "remote"
          ? "已保存：二维码和复制链接都会用远程地址"
          : "已清除：链接回到局域网地址",
      );
    } catch (error) {
      setLanMessage(errorText(error));
    } finally {
      setRemoteBaseSaving(false);
    }
  };

  const toggleUpdateCheckOnStart = () => {
    const current = desktopSettings ?? DEFAULT_DESKTOP_SETTINGS;
    const next = !current.updateCheckOnStart;
    setDesktopError(null);
    setDesktopSettings({ ...current, updateCheckOnStart: next });
    void writeDesktopSettings({ updateCheckOnStart: next }).catch((error) =>
      setDesktopError(errorText(error)),
    );
  };

  const saveEndpoint = async () => {
    const trimmed = endpoint.trim();
    setEndpointSaving(true);
    setDesktopError(null);
    setEndpointMessage(null);
    setUpdateResult(null);
    try {
      await writeDesktopSettings({ updateEndpoint: trimmed });
      setEndpoint(trimmed);
      setDesktopSettings((current) =>
        current ? { ...current, updateEndpoint: trimmed } : current,
      );
      setEndpointMessage(
        trimmed ? "已保存，点「检查更新」试试" : "已清空，不再检查更新",
      );
    } catch (error) {
      setDesktopError(errorText(error));
    } finally {
      setEndpointSaving(false);
    }
  };

  const runUpdateCheck = async () => {
    setUpdateChecking(true);
    setDesktopError(null);
    setUpdateMessage(null);
    setUpdateResult(null);
    try {
      setUpdateResult(await checkForUpdate());
    } catch (error) {
      setUpdateMessage(errorText(error));
    } finally {
      setUpdateChecking(false);
    }
  };

  const applyUpdate = async () => {
    setInstalling(true);
    setDesktopError(null);
    setUpdateMessage("正在下载更新包，下载完会自动安装并重启…");
    try {
      await installUpdate();
      // 正常走不到这里：安装程序起来后当前进程就退出了
      setUpdateMessage("安装程序已启动，应用会自动重启");
    } catch (error) {
      setInstalling(false);
      setUpdateMessage(errorText(error));
    }
  };

  /** 换机器人头像：居中裁 128px 方图（只动头像，不碰背景图库） */
  const pickBotAvatar = async (file: File) => {
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      onBotAvatarChange(await readAvatarImage(file));
    } catch (error) {
      setAvatarError(errorText(error));
    } finally {
      setAvatarBusy(false);
    }
  };

  /** 加背景图：一次可以选多张，逐张压成 1600×1000 并取平均色，压好一起进图库 */
  const pickChatBg = async (files: File[]) => {
    setBgBusy(true);
    setBgError(null);
    const room = Math.max(0, MAX_CHAT_BG - chatBgItems.length);
    const accepted = files.slice(0, room);
    const skipped = files.length - accepted.length;
    const added: ChatBgItem[] = [];
    const failed: string[] = [];
    try {
      for (const [index, file] of accepted.entries()) {
        setBgProgress(`处理中 ${index + 1}/${accepted.length}`);
        try {
          const next = await readChatBackground(file);
          added.push({ id: uid(), ...next });
        } catch (error) {
          failed.push(`${file.name || "图片"}：${errorText(error)}`);
        }
        // 让浏览器有机会把进度画出来（逐张处理不至于卡住整页）
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      setBgProgress(null);
      setBgBusy(false);
    }
    if (added.length > 0) onAddChatBg(added);
    const notes: string[] = [];
    if (failed.length > 0) notes.push(`${failed.length} 张没处理成功（${failed[0]}）`);
    if (skipped > 0) notes.push(`图库最多 ${MAX_CHAT_BG} 张，这次跳过 ${skipped} 张`);
    setBgError(notes.length > 0 ? notes.join("；") : null);
  };

  /** 导出配置：界面偏好 + 桌面设置，**不含 API Key**（文件会被转手，Key 不跟着走） */
  const exportConfig = () => {
    setConfigMessage(null);
    setConfigError(null);
    try {
      const current: Prefs = {
        theme,
        density,
        accent,
        accentHex,
        fontScale,
        radius,
        botName,
        botAvatar,
        chatBgItems,
        chatBgActive,
        chatBgDim,
        chatBgBlur,
        sidebarBgActive,
      };
      const bundle = buildConfigBundle(current, desktopSettings);
      downloadConfigFile(serializeConfigBundle(bundle), configBundleFileName());
      setConfigMessage(
        `已导出（背景图 ${chatBgItems.length} 张${desktopSettings ? "，含桌面设置" : ""}）。` +
          "文件里没有 API Key，换机器后要单独填。",
      );
    } catch (error) {
      setConfigError(`导出失败：${errorText(error)}`);
    }
  };

  /** 导入配置：校验 → 整份替换偏好 →（桌面端）写桌面设置；地址 / 数据目录变了就重启 BFF */
  const importConfig = async (file: File) => {
    setConfigMessage(null);
    setConfigError(null);
    setConfigBusy(true);
    try {
      const result = parseConfigBundle(await file.text());
      if (!result.ok) {
        setConfigError(`导入失败：${result.error}`);
        return;
      }
      onReplacePrefs(result.prefs);
      const notes = [...result.notes];

      if (result.desktop) {
        if (!desktop) {
          notes.push("文件里有桌面设置，浏览器 / 手机上用不上，已忽略");
        } else {
          const before = desktopSettings ?? DEFAULT_DESKTOP_SETTINGS;
          await writeDesktopSettings(result.desktop);
          const next = await readDesktopSettings();
          setDesktopSettings(next);
          setEndpoint(next.updateEndpoint);
          setAstrbotUrl(next.astrbotUrl);
          setAstrbotDataDir(next.astrbotDataDir);
          notes.push("桌面设置已写入");
          if (
            next.astrbotUrl !== before.astrbotUrl ||
            next.astrbotDataDir !== before.astrbotDataDir
          ) {
            setBff(await restartBff());
            notes.push("AstrBot 地址 / 数据目录变了，已重启 BFF");
          }
        }
      }

      if (!desktopSettings?.hasApiKey) {
        notes.push("API Key 不在文件里，记得在「通用」页重新填");
      }
      setConfigMessage(`已导入：${notes.join("；")}`);
    } catch (error) {
      setConfigError(`导入失败：${errorText(error)}`);
    } finally {
      setConfigBusy(false);
    }
  };

  /** 排障：把日志 + 环境信息压成 zip（Key 已打码），成功后把路径显示出来 */
  const exportDiagnosticsBundle = async () => {
    setDiagMessage(null);
    setDiagError(null);
    setDiagBusy(true);
    try {
      setDiagMessage(await exportDiagnostics());
    } catch (error) {
      setDiagError(errorText(error));
    } finally {
      setDiagBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <header className="dialog-head">
          <h2>设置</h2>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>

        <nav className="tabs" aria-label="设置分类">
          {TAB_ITEMS.filter((item) => item.id !== "desktop" || desktop).map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={tab === item.id}
              className={`tab ${tab === item.id ? "on" : ""}`}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {tab === "general" && (
          <>
        <label className="field">
          <span>WebChat 用户名</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="astrbot"
            autoComplete="off"
          />
          <small>
            要和身份桥的映射一致（当前是 <code>webchat:astrbot</code>）。
          </small>
        </label>

        <div className="connection-card">
          <div className="connection-row">
            <span className={`status-dot ${status}`} />
            <strong>
              {status === "online"
                ? "AstrBot 已连接"
                : status === "checking"
                  ? "正在检测…"
                  : "AstrBot 未连接"}
            </strong>
            <button className="link-btn" onClick={onRetry}>
              <RefreshCw size={14} />
              重新检测
            </button>
          </div>
          <p className="muted">
            {baseUrl || "地址由本机 BFF 自动发现（启动器每次启动可能换端口）"}
          </p>
        </div>

        <div className="switch-row">
          <div className="switch-copy">
            <strong>主动消息通知</strong>
            <small>页面隐藏时，新消息用系统通知提醒</small>
          </div>
          <button
            className={`switch ${notifications ? "on" : ""}`}
            onClick={onToggleNotifications}
            aria-pressed={notifications}
            title={notifications ? "关闭通知" : "开启通知"}
          >
            <span />
          </button>
        </div>

        <div className="test-actions">
          {notifications && (
            <button className="link-btn" onClick={onTestNotification}>
              测试通知
            </button>
          )}
          <button className="link-btn" onClick={onTestProactive}>
            测试主动消息
          </button>
        </div>

        <section className="settings-section">
          <div className="section-title">
            备份与迁移
            <span className="section-hint">换电脑 / 换访问地址</span>
          </div>
          <div className="test-actions">
            <button className="pill" onClick={exportConfig} disabled={configBusy}>
              导出配置
            </button>
            <button
              className="pill"
              onClick={() => importInputRef.current?.click()}
              disabled={configBusy}
            >
              {configBusy ? "导入中…" : "导入配置"}
            </button>
          </div>
          <small>
            导出的 JSON 含外观 / 机器人 / 背景图库{desktop ? "和桌面连接设置" : ""}，
            <strong>不含 API Key</strong>，也不含会话列表。换电脑、或从{" "}
            <code>http://IP:8788</code> 换到 <code>https://IP:8789</code>
            （两个源的本地存储是分开的）时用它。
          </small>
          {configMessage && <p className="note">{configMessage}</p>}
          {configError && <p className="note warn">{configError}</p>}
        </section>
          </>
        )}

        {tab === "appearance" && (
          <>
        <section className="settings-section">
          <div className="section-title">
            外观
            <span className="section-hint">立即生效</span>
          </div>
          <div className="field-row">
            <div className="field">
              <span>主题</span>
              <div className="pill-group">
                {THEME_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    className={`pill ${theme === option.value ? "on" : ""}`}
                    onClick={() => onThemeChange(option.value)}
                    title={option.hint}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <small>深色不刺眼，浅色白天更清楚。</small>
            </div>
            <div className="field">
              <span>信息密度</span>
              <div className="pill-group">
                {DENSITY_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    className={`pill ${density === option.value ? "on" : ""}`}
                    onClick={() => onDensityChange(option.value)}
                    title={option.hint}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <small>紧凑一屏多看几条。</small>
            </div>
          </div>
          <div className="field">
            <span>强调色</span>
            <div className="swatch-group">
              {ACCENT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`swatch ${accentHex ? "" : accent === option.value ? "on" : ""}`}
                  data-swatch={option.value}
                  onClick={() => onAccentChange(option.value)}
                  title={option.label}
                  aria-label={option.label}
                  aria-pressed={!accentHex && accent === option.value}
                />
              ))}
              <label
                className={`swatch swatch-custom ${accentHex ? "on" : ""}`}
                style={accentHex ? { background: accentHex } : undefined}
                title={accentHex ? `自定义 ${accentHex}` : "自定义颜色"}
              >
                <input
                  type="color"
                  value={accentHex || "#6ea8fe"}
                  onChange={(event) => onAccentHexChange(event.target.value)}
                  aria-label="自定义强调色"
                />
              </label>
            </div>
            <small>
              链接、焦点框、主按钮和你的气泡都跟着换色；最后一个色块可以自己挑色值。
            </small>
          </div>
          <div className="field-row">
            <div className="field">
              <span>字号</span>
              <div className="pill-group">
                {FONT_SCALE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    className={`pill ${fontScale === option.value ? "on" : ""}`}
                    onClick={() => onFontScaleChange(option.value)}
                    title={option.hint}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <small>只影响正文和元信息。</small>
            </div>
            <div className="field">
              <span>圆角</span>
              <div className="pill-group">
                {RADIUS_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    className={`pill ${radius === option.value ? "on" : ""}`}
                    onClick={() => onRadiusChange(option.value)}
                    title={option.hint}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <small>圆形按钮不受影响。</small>
            </div>
          </div>
        </section>

        <section className="settings-section">
          <div className="section-title">
            侧栏背景<span className="section-hint">会话列表单独一张</span>
          </div>
          <div className="field">
            <span>从图库选</span>
            <div className="bg-grid">
              <button
                type="button"
                className={`bg-add ${sidebarBgActive === "" ? "on" : ""}`}
                onClick={() => onSidebarBgChange("")}
                title="不铺侧栏背景"
              >
                不使用
              </button>
              {chatBgItems.map((item) => (
                <div
                  key={item.id}
                  className={`bg-item ${sidebarBgActive === item.id ? "on" : ""}`}
                >
                  <button
                    type="button"
                    className="bg-pick"
                    onClick={() => onSidebarBgChange(item.id)}
                    title={sidebarBgActive === item.id ? "侧栏正在用这张" : "用这张当侧栏背景"}
                    aria-label="用这张当侧栏背景"
                    aria-pressed={sidebarBgActive === item.id}
                  >
                    <img src={item.image} alt="" />
                  </button>
                </div>
              ))}
            </div>
            <small>和「聊天背景」互相独立：聊天区可以空着，侧栏单独铺一张。</small>
          </div>
        </section>
        <section className="settings-section">
          <div className="section-title">
            聊天背景<span className="section-hint">只铺聊天区</span>
          </div>
          <div className="field">
            <span>背景图库</span>
            <div className="bg-grid">
              {chatBgItems.map((item) => (
                <div
                  key={item.id}
                  className={`bg-item ${chatBgActive === item.id ? "on" : ""}`}
                >
                  <button
                    type="button"
                    className="bg-pick"
                    onClick={() => onSelectChatBg(item.id)}
                    title={chatBgActive === item.id ? "正在用这张" : "用这张当背景"}
                    aria-label="用这张当背景"
                    aria-pressed={chatBgActive === item.id}
                  >
                    <img src={item.image} alt="" />
                  </button>
                  <button
                    type="button"
                    className="bg-del"
                    onClick={() => onRemoveChatBg(item.id)}
                    title="删除这张"
                    aria-label="删除这张背景图"
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="bg-add"
                onClick={() => bgInputRef.current?.click()}
                disabled={bgBusy || chatBgItems.length >= MAX_CHAT_BG}
                title={
                  chatBgItems.length >= MAX_CHAT_BG
                    ? `图库最多 ${MAX_CHAT_BG} 张`
                    : "可以一次选多张"
                }
              >
                {bgBusy ? (bgProgress ?? "处理中…") : "＋ 添加图片"}
              </button>
            </div>
            <div className="bg-actions">
              {chatBgActive ? (
                <button className="link-btn" onClick={() => onSelectChatBg("")}>
                  先不用背景图
                </button>
              ) : null}
              <span className="section-hint">
                {chatBgItems.length}/{MAX_CHAT_BG}
              </span>
            </div>
            {bgError && <p className="note warn">{bgError}</p>}
            <small>
              可以一次选多张；点缩略图切换，右上角 × 删除。图会缩到最多 1600×1000
              存本地，侧栏和聊天头会按它取的平均色轻轻染一层。
            </small>
          </div>
          <div className="field-row">
            <div className="field">
              <span>背景明暗</span>
              <div className="pill-group">
                {CHAT_BG_DIM_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    className={`pill ${chatBgDim === option.value ? "on" : ""}`}
                    onClick={() => onChatBgDimChange(option.value)}
                    title={option.hint}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <small>压暗一点字更好认。</small>
            </div>
            <div className="field">
              <span>背景虚化</span>
              <div className="pill-group">
                {CHAT_BG_BLUR_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    className={`pill ${chatBgBlur === option.value ? "on" : ""}`}
                    onClick={() => onChatBgBlurChange(option.value)}
                    title={option.hint}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <small>选图时一次算好。</small>
            </div>
          </div>
        </section>
          </>
        )}

        {tab === "bot" && (
          <>
        <section className="settings-section">
          <div className="section-title">
            机器人<span className="section-hint">只影响本机显示</span>
          </div>
          <div className="field">
            <span>名字</span>
            <input
              value={botName}
              onChange={(event) => onBotNameChange(event.target.value)}
              placeholder="AstrBot"
              maxLength={24}
              autoComplete="off"
              spellCheck={false}
            />
            <small>
              侧栏左上角、空状态那句「和 … 说点什么吧」和通知标题都用它；留空回到
              AstrBot。
            </small>
          </div>
          <div className="field">
            <span>头像</span>
            <div className="media-row">
              <div className="avatar-preview" aria-hidden="true">
                {botAvatar ? <img src={botAvatar} alt="" /> : initialOf(botName)}
              </div>
              <button
                className="pill"
                onClick={() => avatarInputRef.current?.click()}
                disabled={avatarBusy}
              >
                {avatarBusy ? "处理中…" : botAvatar ? "换一张" : "选图片"}
              </button>
              {botAvatar && (
                <button
                  className="link-btn"
                  onClick={() => {
                    setAvatarError(null);
                    onBotAvatarChange("");
                  }}
                >
                  恢复默认头像
                </button>
              )}
            </div>
            {avatarError && <p className="note warn">换头像失败：{avatarError}</p>}
            <small>
              自动居中裁成 128px 方图存本地（几 KB）；也可以直接点聊天头部的头像换。
              这里只动头像，和下面的聊天背景互不影响。
            </small>
          </div>
        </section>
          </>
        )}

        {/* 选图用的隐藏输入框：跟着组件常驻，切 tab 也不会把 ref 弄没 */}
        <input
          ref={avatarInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void pickBotAvatar(file);
            event.target.value = "";
          }}
        />
        <input
          ref={bgInputRef}
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
        {/* 导入配置用的隐藏输入框：accept 只做提示，真正的校验在 parseConfigBundle 里 */}
        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importConfig(file);
            event.target.value = "";
          }}
        />

        {tab === "desktop" && desktop && (
          <>
        <section className="settings-section">
            <div className="section-title">
              桌面端<span className="section-hint">改动即时生效</span>
            </div>

            <div className="field">
              <span>AstrBot 地址</span>
              <div className="key-input">
                <input
                  value={astrbotUrl}
                  onChange={(event) => setAstrbotUrl(event.target.value)}
                  placeholder="留空 = 自动发现本机；远端填 http://主机:端口"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  className="link-btn"
                  onClick={() => void saveAstrbotUrl()}
                  disabled={urlSaving}
                >
                  {urlSaving ? "保存中…" : "保存"}
                </button>
              </div>
              <small>
                留空时由 BFF 扫本机端口找 AstrBot（推荐）；AstrBot 在云主机 / 另一台机器上时填它的
                http(s) 地址，保存后会自动重启 BFF。当前自动发现到：
                <code>{baseUrl || "（还没连上）"}</code>
              </small>
              {urlMessage && <span className="key-message">{urlMessage}</span>}
            </div>

            <div className="field">
              <span>AstrBot 数据目录</span>
              <div className="key-input">
                <input
                  value={astrbotDataDir}
                  onChange={(event) => setAstrbotDataDir(event.target.value)}
                  placeholder="留空 = 自动找；例：/home/xxx/astrbot/data 或 C:\...\core\data"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  className="link-btn"
                  onClick={() => void saveAstrbotDataDir()}
                  disabled={dataDirSaving}
                >
                  {dataDirSaving ? "保存中…" : "保存"}
                </button>
              </div>
              <small>
                只用来读<strong>本地</strong>历史库 <code>data_v4.db</code>；远端 AstrBot / 容器里读不到时留空即可。
                填了就以它为准（<code>~/astrbot/data</code> 这种带 <code>~</code> 的写法也行，会自动展开）；
                留空时自己找：先从运行中的 AstrBot 进程推，再试 <code>~/astrbot/data</code>、
                <code>$XDG_DATA_HOME/astrbot/data</code>、<code>/opt/astrbot/data</code>。
                诊断：打开 <code>http://127.0.0.1:8788/astrbot/api/db-status</code> 看实际用的是哪个库、从哪推出来的。
              </small>
              {dataDirMessage && <span className="key-message">{dataDirMessage}</span>}
            </div>

            <div className="field">
              <span>关闭窗口时</span>
              <div className="pill-group">
                {CLOSE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    className={`pill ${
                      (desktopSettings?.closeBehavior ?? "ask") === option.value
                        ? "on"
                        : ""
                    }`}
                    onClick={() => changeCloseBehavior(option.value)}
                    disabled={desktopSettings === null}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <small>点右上角关闭或按 Alt+F4 时执行；托盘里可以随时退出。</small>
            </div>

            <div className="field">
              <span>AstrBot API Key</span>
              <div className="key-input">
                <input
                  type={keyRevealed ? "text" : "password"}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="没填的话桌面版连不上 AstrBot"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => setKeyRevealed((value) => !value)}
                >
                  {keyRevealed ? "隐藏" : "显示"}
                </button>
              </div>
              <div className="key-actions">
                <button
                  className="link-btn"
                  onClick={() => void saveApiKey()}
                  disabled={keySaving}
                >
                  {keySaving ? "正在重启 BFF…" : "保存并重启 BFF"}
                </button>
                <button
                  className="link-btn"
                  onClick={() => void runKeyCheck()}
                  disabled={keyTesting}
                >
                  {keyTesting ? "正在测试…" : "测试连接"}
                </button>
                {keyMessage && <span className="key-message">{keyMessage}</span>}
              </div>
              {keyCheck && (
                <span className="key-message">{probeText(keyCheck)}</span>
              )}
              <small>
                存在本机 <code>settings.json</code> 里，启动 BFF 时通过环境变量传入。
                {bff
                  ? `当前 BFF：${
                      bff.running
                        ? `${bff.managed ? "壳托管" : "外部复用"}${
                            bff.pid ? ` · pid ${bff.pid}` : ""
                          }${bff.healthy ? " · 正常" : " · 未响应"}`
                        : "未运行"
                    }`
                  : ""}
              </small>
              {bff?.error && <p className="note warn">{bff.error}</p>}
            </div>

            <div className="field">
              <span>会话管理增强（可选插件）</span>
              <small>
                {adminAvailable
                  ? `已启用 astrbot_plugin_webchat_admin v${adminVersion || "?"}：可删会话、改服务端会话名、读远端历史。`
                  : "未安装 astrbot_plugin_webchat_admin：删除会话 / 服务端改名 / 远端历史都不可用（改名仍可当本地备注）。"}
              </small>
              <small>
                装法：AstrBot 面板 → 插件 → 上传 zip（仓库里 `plugins/astrbot_plugin_webchat_admin`）。
                需要 Key 带 <code>plugin</code> scope，和记忆抽屉一样。
              </small>
            </div>

            <div className="switch-row">
              <div className="switch-copy">
                <strong>开机自启</strong>
                <small>登录 Windows 后自动启动（默认直接进托盘之外的主窗口）</small>
              </div>
              <button
                className={`switch ${autostart ? "on" : ""}`}
                onClick={toggleAutostart}
                aria-pressed={autostart}
                title={autostart ? "关闭开机自启" : "开启开机自启"}
              >
                <span />
              </button>
            </div>

            <div className="switch-row">
              <div className="switch-copy">
                <strong>启动时自动拉起 AstrBot</strong>
                <small>由桌面壳托管 AstrBot / BFF 的启动（P2 接入后生效）</small>
              </div>
              <button
                className={`switch ${
                  (desktopSettings ?? DEFAULT_DESKTOP_SETTINGS)
                    .autoLaunchAstrbot
                    ? "on"
                    : ""
                }`}
                onClick={toggleAutoLaunch}
                aria-pressed={
                  (desktopSettings ?? DEFAULT_DESKTOP_SETTINGS)
                    .autoLaunchAstrbot
                }
                disabled={desktopSettings === null}
                title="切换启动时是否拉起 AstrBot"
              >
                <span />
              </button>
            </div>

            {desktopError && <p className="note warn">{desktopError}</p>}
          </section>

          <section className="settings-section">
            <div className="section-title">
              手机访问
              <span className="section-hint">同一个 Wi-Fi，或走 tailnet 远程直连</span>
            </div>

            <div className="switch-row">
              <div className="switch-copy">
                <strong>允许局域网访问</strong>
                <small>
                  开启后 BFF 监听 0.0.0.0（非本机请求必须带令牌），并直接提供前端页面
                </small>
              </div>
              <button
                className={`switch ${lan?.enabled ? "on" : ""}`}
                onClick={() => void toggleLan()}
                aria-pressed={lan?.enabled ?? false}
                disabled={lan === null || lanBusy}
                title={lan?.enabled ? "关闭局域网访问" : "开启局域网访问"}
              >
                <span />
              </button>
            </div>

            <div className="field">
              <span>远程地址（Tailscale Serve 之类，可选）</span>
              <div className="key-input">
                <input
                  value={remoteBase}
                  onChange={(event) => setRemoteBase(event.target.value)}
                  placeholder="https://host.tailnet.ts.net:8443"
                  spellCheck={false}
                  autoComplete="off"
                />
                <button
                  className="link-btn"
                  onClick={() => void saveRemoteBase(remoteBase)}
                  disabled={remoteBaseSaving}
                >
                  {remoteBaseSaving ? "保存中…" : "保存"}
                </button>
                {lan?.remoteBase ? (
                  <button
                    className="link-btn"
                    onClick={() => void saveRemoteBase("")}
                    disabled={remoteBaseSaving}
                  >
                    清除
                  </button>
                ) : null}
              </div>
              <small>
                填了就用它拼二维码和复制链接 —— 手机和电脑都装 Tailscale、登录同一个账号就能连，
                不要求同一个 Wi-Fi；留空则用局域网地址。APK 认端口，Tailscale Serve 请写{" "}
                <code>:8443</code>。
              </small>
              {remotePortMissing(lan?.remoteBase ?? "") ? (
                <p className="note warn">
                  这个地址没写端口：手机 APK 会把 <code>https://主机名</code> 补成{" "}
                  <code>:8789</code> 而连不上。Tailscale Serve 用 <code>:8443</code>
                  （写 443 也会被 URL 规范吃掉，同样变成无端口）。
                </p>
              ) : null}
            </div>

            {lan?.enabled && lan.url ? (
              <>
                {/* 第一步：装证书。只有走局域网自签 https 才需要 */}
                {lan.urlSource === "lan-https" && lan.caUrl ? (
                  <div className="lan-step">
                    <div className="lan-step-head">
                      <span className="lan-step-index">1</span>
                      <strong>先在手机上装证书</strong>
                      <span className="lan-step-hint">只做一次；装在手机上，不是电脑</span>
                    </div>
                    <div className="pairing-row">
                      <QrCanvas
                        value={lan.caUrl}
                        className="ca-canvas"
                        label="自签证书下载二维码"
                      />
                      <div className="pairing-copy">
                        <p className="pairing-title">扫这个码下载证书</p>
                        <p className="pairing-hint">
                          手机扫完会下载 <code>ca.cer</code>，按系统装好，再扫第二步的配对码。
                          顺序反了会看到「证书不受信任」，那是正常的 —— 装完证书刷新一下就行。
                        </p>
                        <ol className="lan-steps">
                          <li>安卓：设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书 → 选 ca.cer</li>
                          <li>
                            iOS：设置 → 已下载描述文件 → 安装；再到「通用 → 关于本机 → 证书信任设置」
                            打开完全信任
                          </li>
                        </ol>
                        <div className="pairing-actions">
                          <button className="link-btn" onClick={() => void copyCaUrl()}>
                            复制下载链接
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}

                {/* 第二步：扫码配对（http 模式下就是第一步） */}
                <div className="lan-step">
                  <div className="lan-step-head">
                    <span className="lan-step-index">
                      {lan.urlSource === "lan-https" && lan.caUrl ? "2" : "1"}
                    </span>
                    <strong>扫码配对</strong>
                    <span className="lan-step-hint">
                      {lan.urlSource === "remote"
                        ? "走 tailnet，不要求同一个 Wi-Fi；令牌会写进手机的 cookie"
                        : "同一个 Wi-Fi；令牌会写进手机的 cookie"}
                    </span>
                  </div>
                  <div className="pairing-row">
                    <PairingCode url={lan.url} />
                    <div className="pairing-copy">
                      <p className="pairing-title">用手机扫这个二维码</p>
                      <p className="pairing-hint">
                        扫完直接进聊天页，不用手打地址。二维码的内容就是访问令牌 ——{" "}
                        <strong>别截图转发</strong>，60 秒后会自动收起。
                      </p>
                      {lanResetArmed ? (
                        <div className="pairing-confirm">
                          <span>重置后所有手机都要重新扫，确定？</span>
                          <div className="pairing-actions">
                            <button
                              className="link-btn danger"
                              onClick={() => void resetLan()}
                              disabled={lanBusy}
                            >
                              {lanBusy ? "正在重置…" : "确定重置"}
                            </button>
                            <button
                              className="link-btn"
                              onClick={() => setLanResetArmed(false)}
                              disabled={lanBusy}
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          className="link-btn pairing-reset"
                          onClick={() => setLanResetArmed(true)}
                        >
                          重置配对（手机丢了 / 二维码外泄时用）
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                <div className="field">
                  <span>或者把链接复制给手机</span>
                  <div className="key-input">
                    <input
                      readOnly
                      value={lan.url}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <button className="link-btn" onClick={() => void copyLanUrl()}>
                      复制
                    </button>
                  </div>
                  <small>
                    {lan.urlSource === "remote"
                      ? "手机和电脑都装 Tailscale、登录同一个账号即可，不要求同一个 Wi-Fi。令牌会写进手机浏览器的 cookie，之后直接开这个地址就行。"
                      : "手机和电脑要连同一个 Wi-Fi；第一次打开可能要放行 Windows 防火墙的「专用网络」。令牌会写进手机浏览器的 cookie，之后直接开这个地址就行。"}
                  </small>
                </div>
              </>
            ) : null}

            {lan?.enabled && !lan.url ? (
              <p className="note warn">
                还没拼出链接：没取到局域网 IP（可能没连网络），或者还没有令牌。
                把上面的开关关掉再打开一次。
              </p>
            ) : null}

            {lan?.enabled && lan.urlSource === "remote" ? (
              <p className="note">
                正在用远程地址 <code>{lan.remoteBase}</code>：手机和 PC 都装 Tailscale
                并登录同一个账号就能连，不用同一个 Wi-Fi。证书由 Tailscale 签发，手机不用装自签证书。
                地址变了（换了机器名 / 端口）在这里改完保存即可，不用重装桌面端。
              </p>
            ) : null}

            {lan?.enabled && lan.urlSource === "lan-https" ? (
              <p className="note">
                已启用 HTTPS（自签证书 8789）。装完证书后手机才有 PWA 安装、录音和安全上下文。
                {lan.caUrl ? (
                  <>
                    {" "}
                    证书文件：{" "}
                    <a href={lan.caUrl} target="_blank" rel="noreferrer">
                      {lan.caUrl}
                    </a>
                  </>
                ) : (
                  "没找到 ca.cer：把「当前用户 → 受信任的根证书颁发机构」里的 AstrBot Chat Local CA 导出成 DER 再给手机装。"
                )}
              </p>
            ) : null}

            {lan?.enabled && lan.urlSource === "lan-http" ? (
              <p className="note">
                现在只有 HTTP：手机上装不了 PWA、录不了音（http://IP 不是安全上下文）。
                在项目目录跑一次{" "}
                <code>powershell -File scripts\lan-tls.ps1</code> 生成自签证书，再把上面的
                开关关掉重开就会启用 HTTPS（8789）。
              </p>
            ) : null}

            {lanMessage && <span className="key-message">{lanMessage}</span>}
          </section>

          <section className="settings-section">
            <div className="section-title">
              软件更新
              <span className="section-hint">需要自建更新源，不填就不检查</span>
            </div>

            <div className="update-card">
              <div className="update-row">
                <strong>当前版本 v{desktopSettings?.appVersion || "—"}</strong>
                <button
                  className="link-btn"
                  onClick={() => void runUpdateCheck()}
                  disabled={updateChecking || installing}
                >
                  <RefreshCw size={14} />
                  {updateChecking ? "正在检查…" : "检查更新"}
                </button>
              </div>

              {updateResult?.status === "up-to-date" && (
                <span className="key-message">已经是最新版本</span>
              )}
              {updateResult?.status === "not-configured" && (
                <span className="key-message muted">
                  还没填更新源，填下面的地址才能检查
                </span>
              )}
              {updateResult?.status === "available" && (
                <div className="update-available">
                  <span>
                    发现新版本 v{updateResult.version}
                    {updateResult.notes ? `：${updateResult.notes}` : ""}
                  </span>
                  <button
                    className="link-btn"
                    onClick={() => void applyUpdate()}
                    disabled={installing}
                  >
                    {installing ? "正在下载并安装…" : "立即更新并重启"}
                  </button>
                </div>
              )}
              {updateMessage && (
                <span className="key-message">{updateMessage}</span>
              )}
            </div>

            <div className="field">
              <span>更新源地址</span>
              <div className="key-input">
                <input
                  value={endpoint}
                  onChange={(event) => setEndpoint(event.target.value)}
                  placeholder="https://你的服务器/astrbot/latest.json"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  className="link-btn"
                  onClick={() => void saveEndpoint()}
                  disabled={endpointSaving}
                >
                  {endpointSaving ? "保存中…" : "保存"}
                </button>
              </div>
              <small>
                静态服务器上的 <code>latest.json</code>；更新包必须用同一把私钥签名。
                留空就等于不检查更新（默认就是这样）。
              </small>
              {endpointMessage && (
                <span className="key-message">{endpointMessage}</span>
              )}
            </div>

            <div className="switch-row">
              <div className="switch-copy">
                <strong>启动时自动检查更新</strong>
                <small>只在填了更新源时生效；连不上就静默跳过</small>
              </div>
              <button
                className={`switch ${
                  (desktopSettings ?? DEFAULT_DESKTOP_SETTINGS)
                    .updateCheckOnStart
                    ? "on"
                    : ""
                }`}
                onClick={toggleUpdateCheckOnStart}
                aria-pressed={
                  (desktopSettings ?? DEFAULT_DESKTOP_SETTINGS)
                    .updateCheckOnStart
                }
                disabled={desktopSettings === null}
                title="切换启动时是否检查更新"
              >
                <span />
              </button>
            </div>
          </section>

        <p className="note">
          API Key 保存在本机 BFF 的 <code>.env.local</code>，不会发送到浏览器。
        </p>

        <section className="settings-section">
          <div className="section-title">
            排障
            <span className="section-hint">给测试者 / 反馈问题时用</span>
          </div>
          <div className="test-actions">
            <button
              className="pill"
              onClick={() => void exportDiagnosticsBundle()}
              disabled={diagBusy}
            >
              {diagBusy ? "打包中…" : "导出诊断包"}
            </button>
          </div>
          <small>
            把应用日志、BFF 的 out / err 日志和环境信息压成一个 zip（
            <strong>Key 和局域网令牌已经打码</strong>
            ），存在「下载」目录并自动定位。不联网、不上传，发不发由你决定。
          </small>
          {diagMessage && <p className="note">已导出：{diagMessage}</p>}
          {diagError && <p className="note warn">导出失败：{diagError}</p>}
        </section>
          </>
        )}

        <footer className="dialog-foot">
          <button className="ghost-btn" onClick={onClose}>
            取消
          </button>
          <button className="primary-btn" onClick={() => onSave(name)}>
            保存
          </button>
        </footer>
      </div>
    </div>
  );
}




