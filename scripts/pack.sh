#!/bin/sh
# 打出上传 extensions.gnome.org 的 zip。
#
# ⚠️ 包里只放**运行时**要用到的东西。上一次提交被自动拒的原因之一，就是
# README.md 混进了 zip：审查规则明确写着「不要包含运行不需要的文件」，
# 构建/安装脚本、.po/.pot、用不上的素材都算。这个仓库里真正不能进包的是：
#
#   README.md docs/ install.sh scripts/ systemd/ tests/ po/ meson.build .github/
#
# systemd/ 与 scripts/ 尤其要挡住——它们是**一次性的宿主机配置**（用户单元、
# setcap、polkit 规则），由 install.sh 在本机跑，不是扩展的一部分。
#
# 用 gnome-extensions pack 而不是手写 zip：它只收自己认识的那几样，
# 顺手编译 schema 和翻译，少一处能出错的地方。
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
UUID='singbox@anyfq.com'
DOMAIN='gname-shell-extension-singbox'
ZIP="$PROJECT_DIR/$UUID.shell-extension.zip"

cd "$PROJECT_DIR"

if ! command -v gnome-extensions >/dev/null 2>&1; then
    printf '%s\n' '未找到 gnome-extensions（gnome-shell 自带），无法打包。' >&2
    exit 1
fi

gnome-extensions pack --force \
    --extra-source=lib \
    --extra-source=icons \
    --podir=po \
    --gettext-domain="$DOMAIN" \
    --schema="schemas/org.gnome.shell.extensions.$DOMAIN.gschema.xml" \
    --out-dir="$PROJECT_DIR" \
    "$PROJECT_DIR"

printf '\n%s\n' "-- $ZIP 的内容 --"
unzip -Z1 "$ZIP" | sort

# 白名单式验收：列出来的东西之外一律算漏网。黑名单会漏掉下次新加的目录，
# 这个仓库在别处已经栽过「模式漏命名」的跟头。
unexpected=$(unzip -Z1 "$ZIP" | sed 's#/$##' | grep -vE \
    '^(extension\.js|prefs\.js|metadata\.json|lib(/[a-zA-Z0-9._-]+\.js)?|icons(/[a-zA-Z0-9._-]+\.svg)?|schemas(/.*)?|locale(/.*)?)$' || true)

if [ -n "$unexpected" ]; then
    printf '\n%s\n' '!! 包里有不该出现的文件：' >&2
    printf '%s\n' "$unexpected" >&2
    exit 1
fi

printf '\n%s（%s 字节）\n' '包内容干净，可以上传。' "$(stat -c %s "$ZIP")"
