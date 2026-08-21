#!/bin/sh
# 生成翻译模板。
#
# 这条 xgettext 调用曾经在两个地方各存一份（CI 的 workflow 里，以及改代码的人
# 手敲的那份），参数一旦对不上，CI 就报「模板过期」而 diff 里全是无意义的差异。
# 抽到这里，CI 和本地跑的是同一条命令。
#
# 用法：
#   ./scripts/update-pot.sh              # 写回 po/ 下的模板
#   ./scripts/update-pot.sh /tmp/x.pot   # 写到别处（CI 拿它做比对）
#
# --add-location=file 只保留文件名、不写行号：行号会随任何一次无关的代码移动
# 变化，让模板显得「过期」而实际字符串一个没变。这类 diff 不携带信息，只会把
# CI 变成噪音源。文件名对译者已经够用。
set -eu

cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
OUT=${1:-po/gname-shell-extension-singbox.pot}

xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ \
    --add-location=file \
    --package-name="sing-box Link Manager" --package-version=1 \
    --copyright-holder="sing-box Link Manager contributors" \
    --msgid-bugs-address="https://github.com/gname/gname-shell-extension-singbox/issues" \
    -f po/POTFILES.in -o "$OUT"
