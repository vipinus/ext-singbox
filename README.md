# sing-box GNOME Shell Extension

GNOME Shell extension for importing and managing sing-box VPN links.

## Features

- Import `vless://`, `vmess://`, `trojan://`, `ss://`, `hysteria2://` (or `hy2://`) links.
- Import a QR-code image through `zbarimg` when it is installed.
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

安装脚本会通过 `pkexec` 请求一次系统授权，自动执行 `modprobe tun`，并为 sing-box
设置 `CAP_NET_ADMIN` 和 `CAP_NET_RAW`。扩展本身始终以当前用户运行，不会以 root 运行。
脚本同时会编译 GSettings schema 并安装翻译。

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
