#!/bin/sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
UUID='singbox@anyfq.com'
DOMAIN='gname-shell-extension-singbox'
INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
USER_UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SING_BOX=${SING_BOX_BIN:-$(command -v sing-box || true)}

if [ -z "$SING_BOX" ] || [ ! -x "$SING_BOX" ]; then
    printf '%s\n' '未找到 sing-box，请先安装它，或设置 SING_BOX_BIN。' >&2
    exit 1
fi

# 特权部分做三件事：tun 设备、sing-box 的 capabilities、免密弹窗的 polkit 规则。
# 三件都是幂等的，所以先查一遍，都就位就不必再要一次密码——调试期间会反复重装，
# 每次都输密码纯属白输。
#
# ⚠️ polkit 规则不能用「文件在不在」来判断：/etc/polkit-1/rules.d 是
# root:polkitd 0750，普通用户连 stat 都不行。改成用 pkcheck 直接问 polkitd
# 「我现在有没有这个权限」——这是功能验证，比文件存在性这种代理指标可靠：
# 规则被删、被改窄、或写的是别的用户，它都会如实返回未授权。
privileged_setup_needed() {
    [ -n "${FORCE_PRIVILEGED_SETUP:-}" ] && return 0

    [ -c /dev/net/tun ] || return 0

    getcap_bin=$(command -v getcap 2>/dev/null || echo /usr/sbin/getcap)
    [ -x "$getcap_bin" ] || return 0
    caps=$("$getcap_bin" "$SING_BOX" 2>/dev/null) || return 0
    case "$caps" in *cap_net_admin*) ;; *) return 0 ;; esac
    case "$caps" in *cap_net_raw*) ;; *) return 0 ;; esac

    command -v pkcheck >/dev/null 2>&1 || return 0
    # 只查连接/断开路径上真正用到的四个。规则实际放行八个，多出来的是
    # sing-box 在别的配置下才会调的，缺了它们也不必重跑整个特权步骤。
    for action in set-dns-servers set-domains set-default-route revert; do
        pkcheck --action-id "org.freedesktop.resolve1.$action" \
            --process $$ >/dev/null 2>&1 || return 0
    done

    return 1
}

if privileged_setup_needed; then
    # 第二个参数是给 pkexec 没设 PKEXEC_UID 时兜底用的（例如改用 sudo 运行）。
    printf '%s\n' '需要系统授权：加载 tun 模块、授予 sing-box 网络管理能力，并免去连接时的密码弹窗。'
    pkexec "$PROJECT_DIR/scripts/privileged-setup.sh" "$SING_BOX" "$(id -un)"
else
    printf '%s\n' '系统授权已就位（tun / capabilities / polkit 规则），跳过 pkexec。'
    printf '%s\n' '要强制重做：FORCE_PRIVILEGED_SETUP=1 ./install.sh'
fi

rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/schemas" "$INSTALL_DIR/lib" "$INSTALL_DIR/icons"

cp "$PROJECT_DIR/metadata.json" "$PROJECT_DIR/extension.js" "$PROJECT_DIR/prefs.js" "$INSTALL_DIR/"
cp "$PROJECT_DIR/lib/config.js" "$PROJECT_DIR/lib/fetch.js" \
    "$PROJECT_DIR/lib/singboxService.js" "$INSTALL_DIR/lib/"
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

# 后端单元。扩展自己不起任何进程——它只通过会话总线对这个单元发 StartUnit/StopUnit，
# 所以单元不装的话磁贴只会提示「先运行 install.sh」。它跑在当前用户下，不需要
# root、不需要 polkit；起 TUN 要的 capability 在 sing-box 二进制上（上面那步 setcap）。
#
# 刻意不 enable：这是按需启动的单元，开机不该自己起来。
#
# ExecStart 里的 /usr/bin/env sing-box 在安装时换成**绝对路径**：模板里那样写是
# 为了不写死发行版路径，但装完之后再靠 PATH 去找，跑起来的是哪一个就取决于
# systemd 用户实例的环境——而 setcap 只给了这一个二进制。
mkdir -p "$USER_UNIT_DIR"
sed "s|^ExecStart=.*|ExecStart=$SING_BOX run -c %h/.config/sing-box/ext/config.json|" \
    "$PROJECT_DIR/systemd/singbox-ext.service" > "$USER_UNIT_DIR/singbox-ext.service"
if command -v systemctl >/dev/null 2>&1; then
    # daemon-reload 不能省：单元文件是新的或改过的时候，systemd 不重读就还认旧的
    # （症状是启动报 not-found，或者用的还是上一版的 ExecStart）。
    systemctl --user daemon-reload ||
        printf '%s\n' '⚠️ systemctl --user daemon-reload 失败，登录会话里再手工跑一次。' >&2
else
    printf '%s\n' '⚠️ 未找到 systemctl，单元已复制但没有重新加载。' >&2
fi
printf '已安装后端单元 %s/singbox-ext.service（ExecStart=%s）\n' \
    "$USER_UNIT_DIR" "$SING_BOX"

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

# 这句话曾经写成「注销重登，或在 GNOME Shell 中重启扩展」——后半句是错的，
# 而且是本项目实际栽过的坑：GJS 缓存 ESM 模块，disable/enable 不会重新加载
# extension.js，Wayland 下更没有 Alt+F2 r 这条退路。表现是「改了没生效」，
# 极容易误判成代码写错。所以这里只给唯一正确的做法。
printf '%s\n' '⚠️ 必须注销并重新登录才会加载新的 extension.js。'
printf '%s\n' '   GJS 缓存 ESM 模块，gnome-extensions disable/enable 不会重新加载代码。'
printf '%s\n' '   （prefs.js 不受影响，每次开首选项窗口都是新进程。）'
printf '\n%s\n' '首次安装还需要启用一次：'
printf 'gnome-extensions enable %s\n' "$UUID"
