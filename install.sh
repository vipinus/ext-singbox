#!/bin/sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
UUID='gname-shell-extension-singbox@gnome-shell-extension'
INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
SING_BOX=${SING_BOX_BIN:-$(command -v sing-box || true)}

if [ -z "$SING_BOX" ] || [ ! -x "$SING_BOX" ]; then
    printf '%s\n' '未找到 sing-box，请先安装它，或设置 SING_BOX_BIN。' >&2
    exit 1
fi

printf '%s\n' '需要系统授权：加载 tun 模块并授予 sing-box 网络管理能力。'
pkexec "$PROJECT_DIR/scripts/privileged-setup.sh" "$SING_BOX"

rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/schemas"
cp "$PROJECT_DIR/metadata.json" "$PROJECT_DIR/extension.js" "$PROJECT_DIR/prefs.js" "$PROJECT_DIR/stylesheet.css" "$INSTALL_DIR/"
cp "$PROJECT_DIR/schemas/org.gnome.shell.extensions.gname-shell-extension-singbox.gschema.xml" "$INSTALL_DIR/schemas/"
glib-compile-schemas "$INSTALL_DIR/schemas"

printf '已安装到 %s\n' "$INSTALL_DIR"
printf '%s\n' '请注销并重新登录，或在 GNOME Shell 中重启扩展后启用：'
printf 'gnome-extensions enable %s\n' "$UUID"