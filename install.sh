#!/bin/sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
UUID='gname-shell-extension-singbox@gnome-shell-extension'
DOMAIN='gname-shell-extension-singbox'
INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
SING_BOX=${SING_BOX_BIN:-$(command -v sing-box || true)}

if [ -z "$SING_BOX" ] || [ ! -x "$SING_BOX" ]; then
    printf '%s\n' '未找到 sing-box，请先安装它，或设置 SING_BOX_BIN。' >&2
    exit 1
fi

# 这是整个安装过程唯一一次要密码。它一并把连接/断开时的密码弹窗也免掉了——
# 详见 scripts/privileged-setup.sh 里那段说明，包括免密授权范围的取舍。
# 第二个参数是给 pkexec 没设 PKEXEC_UID 时兜底用的（例如改用 sudo 运行）。
printf '%s\n' '需要系统授权：加载 tun 模块、授予 sing-box 网络管理能力，并免去连接时的密码弹窗。'
pkexec "$PROJECT_DIR/scripts/privileged-setup.sh" "$SING_BOX" "$(id -un)"

rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/schemas" "$INSTALL_DIR/lib" "$INSTALL_DIR/icons"

cp "$PROJECT_DIR/metadata.json" "$PROJECT_DIR/extension.js" "$PROJECT_DIR/prefs.js" "$INSTALL_DIR/"
cp "$PROJECT_DIR/lib/config.js" "$PROJECT_DIR/lib/fetch.js" "$INSTALL_DIR/lib/"
cp "$PROJECT_DIR/icons/singbox-symbolic.svg" "$INSTALL_DIR/icons/"
cp "$PROJECT_DIR/schemas/org.gnome.shell.extensions.$DOMAIN.gschema.xml" "$INSTALL_DIR/schemas/"
glib-compile-schemas "$INSTALL_DIR/schemas"

if command -v msgfmt >/dev/null 2>&1; then
    while read -r lang; do
        [ -n "$lang" ] || continue
        mkdir -p "$INSTALL_DIR/locale/$lang/LC_MESSAGES"
        msgfmt "$PROJECT_DIR/po/$lang.po" -o "$INSTALL_DIR/locale/$lang/LC_MESSAGES/$DOMAIN.mo"
    done < "$PROJECT_DIR/po/LINGUAS"
else
    printf '%s\n' '未找到 msgfmt，跳过翻译安装（界面将显示英文）。' >&2
fi

# QR import is optional, so a missing zbarimg is a warning rather than an error.
# The zbar library is often already present; the command line tool is not.
if ! command -v zbarimg >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
        hint='sudo apt install zbar-tools'
    elif command -v dnf >/dev/null 2>&1; then
        hint='sudo dnf install zbar'
    elif command -v pacman >/dev/null 2>&1; then
        hint='sudo pacman -S zbar'
    else
        hint='请通过发行版包管理器安装 zbar 命令行工具'
    fi
    printf '\n%s\n' '提示：未找到 zbarimg，二维码图片导入将不可用（URL 导入不受影响）。'
    printf '安装命令：%s\n' "$hint"
fi

printf '\n已安装到 %s\n' "$INSTALL_DIR"
printf '%s\n' '请注销并重新登录，或在 GNOME Shell 中重启扩展后启用：'
printf 'gnome-extensions enable %s\n' "$UUID"
