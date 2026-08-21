# sing-box GNOME Shell Extension

GNOME Shell extension for importing and managing sing-box VPN links.

## Features

- Import `vless://`, `vmess://`, `trojan://`, `ss://`, or `hysteria2://` links.
- Import a QR-code image through `zbarimg` when it is installed.
- Keep links in GSettings and sort them by country flag.
- Open a saved connection directly from the panel indicator.
- Delete links from the preferences window.
- Generate a full-tunnel sing-box configuration with automatic routes and DNS hijacking.

## Install locally

```sh
./install.sh
```

安装脚本会通过 `pkexec` 请求一次系统授权，自动执行 `modprobe tun`，并为 sing-box
设置 `CAP_NET_ADMIN` 和 `CAP_NET_RAW`。扩展本身始终以当前用户运行，不会以 root 运行。

也可以使用 Meson 安装到用户目录：

```sh
meson setup build --wipe --prefix="$HOME/.local"
meson install -C build
```

Install `zbarimg` from your distribution if QR image import is needed.

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
sing-box executable uses a different CLI. The executable must be installed and have
permission to create a TUN interface and configure routes (for example through
`CAP_NET_ADMIN` or a suitable polkit/service setup).