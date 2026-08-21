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

# ---------------------------------------------------------------------------
# 免去连接/断开时的密码弹窗
#
# sing-box 以普通用户身份运行（上面的 setcap 只给网络权限，没给 root），
# 而它要通过 DBus 让 systemd-resolved 把 DNS 指进隧道。resolve1 的每个方法
# 都是独立的 polkit action，默认全是 auth_admin_keep——「记住」按 action 记，
# 所以三个方法记不住彼此：实测连接弹三次（set-domains / set-default-route /
# set-dns-servers），断开再弹一次（revert）。
#
# 这里在安装时一次性放行，之后连断都不再问。
#
# ⚠️ 授权范围诚实说明：polkit 规则拿不到调用方的程序路径（Subject 对象没有
# exe 属性），所以**无法只放行 sing-box**。放行的是「这个用户，在本地活动
# 会话里，可以免密配置网卡 DNS」——以该用户身份运行的任何进程都能用，
# 包括把任意网卡的 DNS 指向攻击者的解析器。装之前请知道这一点。
# 不接受这个代价就别装这条规则，代价是每次连断都要输密码。
#
# 只放 sing-box 真正会调的那几个（strings 核对过二进制里的 DBus 方法名），
# register-service / dump-* / subscribe-* 一概不放。
# ---------------------------------------------------------------------------

# 用户名要嵌进 JS 字符串字面量，来源和字符集都得可靠。
# 优先用 pkexec 自己设的 PKEXEC_UID：它由 pkexec 填写，比命令行参数可信。
if [ -n "${PKEXEC_UID:-}" ]; then
    TARGET_USER=$(getent passwd "$PKEXEC_UID" | cut -d: -f1)
else
    TARGET_USER=${2:-}
fi

if [ -z "$TARGET_USER" ]; then
    printf '%s\n' '取不到调用者用户名，跳过 polkit 规则；连接时仍会要求密码。' >&2
    exit 0
fi

# 严格校验：只允许 POSIX 用户名字符集。挡住引号、反斜杠等能逃出字面量的字符。
if ! printf '%s' "$TARGET_USER" | grep -qE '^[a-z_][a-z0-9_-]*$'; then
    printf '用户名含意外字符，拒绝写入 polkit 规则：%s\n' "$TARGET_USER" >&2
    exit 1
fi

if ! id -u "$TARGET_USER" >/dev/null 2>&1; then
    printf '用户不存在：%s\n' "$TARGET_USER" >&2
    exit 1
fi

RULES_DIR=/etc/polkit-1/rules.d
RULES_FILE="$RULES_DIR/50-singbox-resolved.rules"

if [ ! -d "$RULES_DIR" ]; then
    printf '%s\n' '没有 /etc/polkit-1/rules.d（polkit 版本过旧？），跳过；连接时仍会要求密码。' >&2
    exit 0
fi

cat > "$RULES_FILE" <<RULE
// 由 gname-shell-extension-singbox 的 install.sh 安装。
// 让 sing-box 免密配置隧道网卡的 DNS，否则每次连接弹三次密码、断开弹一次。
// 删掉本文件即可恢复默认（代价是弹窗回来）。
polkit.addRule(function(action, subject) {
    if (subject.user !== "$TARGET_USER") return undefined;
    // 只在本地、活动会话里放行：远程或后台会话仍按默认策略要求认证。
    if (!subject.local || !subject.active) return undefined;
    switch (action.id) {
    case "org.freedesktop.resolve1.set-dns-servers":
    case "org.freedesktop.resolve1.set-domains":
    case "org.freedesktop.resolve1.set-default-route":
    case "org.freedesktop.resolve1.set-llmnr":
    case "org.freedesktop.resolve1.set-mdns":
    case "org.freedesktop.resolve1.set-dns-over-tls":
    case "org.freedesktop.resolve1.set-dnssec":
    case "org.freedesktop.resolve1.revert":
        return polkit.Result.YES;
    }
    return undefined;
});
RULE

chmod 644 "$RULES_FILE"
printf '已安装 polkit 规则（%s），用户 %s 连接/断开不再需要密码。\n' "$RULES_FILE" "$TARGET_USER"
