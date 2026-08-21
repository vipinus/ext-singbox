#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    printf '%s\n' '此脚本必须通过 pkexec 运行。' >&2
    exit 1
fi

SING_BOX=${1:-}
case "$SING_BOX" in
    /*) ;;
    *) printf '%s\n' 'sing-box 路径必须是绝对路径。' >&2; exit 1 ;;
esac

if [ ! -x "$SING_BOX" ]; then
    printf 'sing-box 不可执行：%s\n' "$SING_BOX" >&2
    exit 1
fi

modprobe tun
if ! command -v setcap >/dev/null 2>&1; then
    printf '%s\n' '缺少 setcap，请安装 libcap 或 libcap2-bin。' >&2
    exit 1
fi
setcap cap_net_admin,cap_net_raw+ep "$SING_BOX"

printf 'tun 模块已加载，已授权：%s\n' "$SING_BOX"