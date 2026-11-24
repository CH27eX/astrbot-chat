#!/usr/bin/env bash
# 在 macOS 上把 Capacitor 的 ios/ 工程打成 iOS 安装包（.ipa）。
#
# 为什么必须 macOS：iOS 的 .app 要用 Apple 的 Xcode 工具链 + iOS SDK 编译签名，
# Windows / Linux 上没有这套工具（证书、Provisioning Profile、codesign、xcodebuild）。
# 本脚本在 Windows 上会直接报错退出；Windows 侧只能产出「Xcode 工程 + 一键脚本」，
# 到 Mac（或 GitHub Actions 的 macos runner）上跑同一条命令。
#
# 两种用法：
#   1) 不签名（默认）：产出 `AstrBot-Chat_<版本>_unsigned.ipa`，
#      用 Sideloadly / AltStore / TrollStore 自签安装（免费 Apple ID 7 天有效期）。
#        bash scripts/build-ios.sh
#   2) 有 Apple 开发者账号：给 TEAM_ID，自动签名并导出可安装的 ipa。
#        TEAM_ID=ABCDE12345 bash scripts/build-ios.sh
#        TEAM_ID=ABCDE12345 EXPORT_METHOD=ad-hoc bash scripts/build-ios.sh
#
# 产物在 build/ios/ 下，同时复制一份到 D:\Dev\out\releases\<版本>\（Windows 路径）/ 本机
# `~/AstrBot-Chat-releases/<版本>/`（macOS 侧回退），方便和别的平台产物放一起。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[ios] 这个脚本只能在 macOS 上跑：iOS 的编译/签名依赖 Xcode。" >&2
  echo "      当前系统：$(uname -s)。Windows 上请把 ios/ 工程交给 Mac 或 GitHub Actions。" >&2
  exit 1
fi

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "[ios] 找不到 xcodebuild，请先安装 Xcode（App Store）并执行 sudo xcode-select -s /Applications/Xcode.app" >&2
  exit 1
fi

VERSION="$(node -p "require('./package.json').version")"
BUILD_DIR="$ROOT/build/ios"
ARCHIVE="$BUILD_DIR/App.xcarchive"

echo "[ios] 版本 $VERSION，前端构建 + 同步进 ios 工程"
if command -v pnpm >/dev/null 2>&1; then
  pnpm install --frozen-lockfile
  pnpm build
else
  npm install
  npm run build
fi
node node_modules/@capacitor/cli/bin/capacitor sync ios

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

SIGN_ARGS=(
  CODE_SIGNING_ALLOWED=NO
  CODE_SIGNING_REQUIRED=NO
  CODE_SIGN_IDENTITY=""
  CODE_SIGN_ENTITLEMENTS=""
)
if [[ -n "${TEAM_ID:-}" ]]; then
  SIGN_ARGS=(DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic)
  echo "[ios] 自动签名：team $TEAM_ID"
else
  echo "[ios] 不签名构建（产物用 Sideloadly / AltStore 自签安装）"
fi

echo "[ios] xcodebuild archive"
xcodebuild \
  -project ios/App/App.xcodeproj \
  -scheme App \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  archive \
  -allowProvisioningUpdates \
  "${SIGN_ARGS[@]}" \
  | grep -E "error:|warning: .*deprecated|BUILD (SUCCEEDED|FAILED)|\*\* ARCHIVE" || true

if [[ ! -d "$ARCHIVE" ]]; then
  echo "[ios] archive 失败，没生成 $ARCHIVE" >&2
  exit 1
fi

APP="$ARCHIVE/Products/Applications/App.app"
if [[ ! -d "$APP" ]]; then
  echo "[ios] archive 里找不到 App.app：$APP" >&2
  exit 1
fi

if [[ -n "${TEAM_ID:-}" ]]; then
  EXPORT_METHOD="${EXPORT_METHOD:-development}"
  PLIST="$BUILD_DIR/ExportOptions.plist"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>${EXPORT_METHOD}</string>
  <key>teamID</key>
  <string>${TEAM_ID}</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>stripSwiftSymbols</key>
  <true/>
</dict>
</plist>
PLIST
  echo "[ios] 导出签名 ipa（method=$EXPORT_METHOD）"
  xcodebuild -exportArchive \
    -archivePath "$ARCHIVE" \
    -exportOptionsPlist "$PLIST" \
    -exportPath "$BUILD_DIR/export" \
    -allowProvisioningUpdates
  IPA="$(find "$BUILD_DIR/export" -maxdepth 1 -name '*.ipa' | head -n 1)"
  TARGET_NAME="AstrBot-Chat_${VERSION}_signed.ipa"
else
  echo "[ios] 组装未签名 ipa"
  mkdir -p "$BUILD_DIR/Payload"
  cp -R "$APP" "$BUILD_DIR/Payload/"
  ( cd "$BUILD_DIR" && zip -qry "AstrBot-Chat_${VERSION}_unsigned.ipa" Payload )
  IPA="$BUILD_DIR/AstrBot-Chat_${VERSION}_unsigned.ipa"
  TARGET_NAME="AstrBot-Chat_${VERSION}_unsigned.ipa"
fi

DEST=""
if [[ -d "/mnt/d/Dev/out/releases" ]]; then
  DEST="/mnt/d/Dev/out/releases/$VERSION"
elif [[ -n "${ASTRBOT_CHAT_RELEASE_DIR:-}" ]]; then
  DEST="$ASTRBOT_CHAT_RELEASE_DIR/$VERSION"
else
  DEST="$HOME/AstrBot-Chat-releases/$VERSION"
fi
mkdir -p "$DEST"
cp "$IPA" "$DEST/$TARGET_NAME"

SIZE="$(du -h "$DEST/$TARGET_NAME" | cut -f1)"
echo "[ios] 产物：$DEST/$TARGET_NAME（$SIZE）"
if command -v shasum >/dev/null 2>&1; then
  echo "[ios] SHA256：$(shasum -a 256 "$DEST/$TARGET_NAME" | cut -d' ' -f1)"
fi
if [[ -z "${TEAM_ID:-}" ]]; then
  cat <<'TIP'
[ios] 安装提示：
      未签名 ipa 不能直接双击装，用 Sideloadly（Windows / macOS 都行）或 AltStore 自签：
        Sideloadly → 选 ipa → 填 Apple ID → Start → 手机「设置 → 通用 → VPN与设备管理」信任开发者。
      免费 Apple ID 签的有效期 7 天，到期重签即可。
TIP
fi
