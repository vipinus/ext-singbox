# sing-box GNOME Shell Extension

GNOME Shell extension for importing and managing sing-box VPN links.

## Features

- Import `vless://`, `vmess://`, `trojan://`, `ss://`, `hysteria2://` (or `hy2://`) links.
- Import a QR-code image through `zbarimg` when it is installed.
- Import a `sing-box://import-remote-profile` subscription link, storing the
  configuration the provider returns and refreshing it in the background.
- Keep links in GSettings and sort them by country flag.
- Open a saved connection directly from the GNOME Quick Settings menu.
- Delete links from the preferences window.
- Generate a full-tunnel sing-box configuration with automatic routes and DNS hijacking.
- Report backend startup failures in a notification instead of only in the journal.

Requires sing-box 1.12 or newer; the generated configuration uses the DNS server
format introduced in that release.

## Install locally

```sh
./install.sh
```

安装脚本会通过 `pkexec` 请求一次系统授权，做三件事：`modprobe tun`、给 sing-box
设置 `CAP_NET_ADMIN` 与 `CAP_NET_RAW`、安装一条 polkit 规则。扩展与 sing-box
始终以当前用户运行，不会以 root 运行。脚本同时会编译 GSettings schema 并安装翻译。

### 那条 polkit 规则是干什么的

sing-box 要通过 DBus 让 systemd-resolved 把 DNS 指进隧道。resolve1 的每个方法都是
独立的 polkit action，默认全是 `auth_admin_keep`——而「记住」是**按 action 记**的，
所以几个方法记不住彼此。实测的结果是**连接弹三次密码、断开再弹一次**：

| 时机 | sing-box 调的方法 | polkit action |
|---|---|---|
| 连接 | `SetLinkDomains` | `set-domains` |
| 连接 | `SetLinkDefaultRoute` | `set-default-route` |
| 连接 | `SetLinkDNS` | `set-dns-servers` |
| 断开 | `RevertLink` | `revert` |

`/etc/polkit-1/rules.d/50-singbox-resolved.rules` 在安装时一次性放行这些，之后连断
都不再要密码。

⚠️ **授权范围要如实知道**：polkit 规则拿不到调用方的程序路径（Subject 对象没有 `exe`
属性），所以**无法只放行 sing-box**。放行的是「安装它的那个用户，在本地活动会话里，
可以免密配置网卡 DNS」——以该用户身份运行的任何进程都能用，包括把任意网卡的 DNS
指向攻击者的解析器。不接受这个代价就删掉该文件，代价是弹窗回来：

```sh
sudo rm /etc/polkit-1/rules.d/50-singbox-resolved.rules
```

规则的授权范围由 `tests/run.sh` 锁住：放行的 action 集合、限定单一用户、要求本地活动
会话，三者任一被改宽测试就红。

也可以使用 Meson 安装到用户目录：

```sh
meson setup build --wipe --prefix="$HOME/.local"
meson install -C build
```

Install `zbarimg` from your distribution if QR image import is needed; the
preferences window says so explicitly when it is missing.

## TUN permissions

For Linux TUN mode, grant the installed sing-box binary the network administration
capability instead of running the GNOME Shell extension as root:

```sh
sudo setcap cap_net_admin,cap_net_raw+ep "$(command -v sing-box)"
getcap "$(command -v sing-box)"
```

The generated configuration uses `auto_route`, `strict_route`, and DNS hijacking. On
systems where capability-based TUN creation is restricted, run sing-box through a
dedicated privileged system service and set the service command in the preferences.

The default backend command is `sing-box run -c`. Change it in the preferences if your
sing-box executable uses a different CLI; the command is saved when you press Enter or
the apply button, not while you type. The executable must be installed and have
permission to create a TUN interface and configure routes (for example through
`CAP_NET_ADMIN` or a suitable polkit/service setup).

## Subscriptions

A `sing-box://import-remote-profile` link points at a URL that returns a whole
sing-box configuration rather than describing a single node. Importing one fetches
that configuration immediately and stores it; the import fails rather than keeping
an entry that has never been proven to work.

Connecting uses the stored copy, so it never waits on the network. Once connected,
the extension quietly refreshes the stored copy for next time. That refresh is
silent on purpose: the token inside a subscription URL is typically short-lived, so
a failed refresh is the normal steady state, and the credentials already stored keep
working. A refresh never restarts a running connection.

Subscriptions are stored in GSettings alongside share links, in plain text. This is
the same exposure share links already have — their passwords are stored the same
way — but a subscription holds a whole provider configuration, so there is more of it.

## Development

Pure logic — link parsing, configuration generation, failure reporting — lives in
`lib/config.js` so that it can be tested outside a GNOME Shell session.

```sh
./tests/run.sh
```

The suite syntax-checks every source file, runs the unit tests under `gjs`, compiles
the GSettings schema, validates the translations, and — when `sing-box` is on `PATH` —
feeds every generated configuration to `sing-box check`. That last step is what keeps
the generator honest against new sing-box releases.

### Translations

Source strings are English and live in `po/`. After changing any user-visible string:

```sh
xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ \
  --package-name="sing-box Link Manager" --package-version=1 \
  -f po/POTFILES.in -o po/gname-shell-extension-singbox.pot
msgmerge --update po/zh_CN.po po/gname-shell-extension-singbox.pot
```

CI fails if the template is stale.
