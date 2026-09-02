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
- Start and stop the backend as a systemd user service; the extension itself never
  spawns a process.

Requires sing-box 1.12 or newer; the generated configuration uses the DNS server
format introduced in that release.

## Install locally

全新机器上从零到能用，四步：

```sh
# 1. 先装 sing-box 本体（扩展不带二进制，也不会替你装）
#    发行版仓库里通常没有；从 https://github.com/SagerNet/sing-box/releases
#    取对应架构的包，或用发行版自己的源。要 1.12 或更新。
sing-box version

# 2. 装扩展 + 后端单元 + 一次性系统授权
./install.sh

# 3. 启用扩展（只有第一次装需要）
gnome-extensions enable singbox@anyfq.com

# 4. 注销并重新登录
```

⚠️ 第 4 步不能省，也不能用 `gnome-extensions disable/enable` 代替：GJS 缓存 ESM
模块，禁用再启用**不会重新加载 `extension.js`**，Wayland 下也没有 Alt+F2 r 这条退路。
症状是「改了没生效」，极容易误判成代码写错。（`prefs.js` 不受影响，每次开首选项
窗口都是新进程。）

`install.sh` 做四件事：

1. **`pkexec` 一次系统授权**：`modprobe tun`、给 sing-box 设 `CAP_NET_ADMIN` 与
   `CAP_NET_RAW`、装一条 polkit 规则（下面详述）。扩展与 sing-box 始终以当前用户
   运行，不会以 root 运行。
2. **装扩展本身**到 `~/.local/share/gnome-shell/extensions/`，并编译 GSettings
   schema 与翻译。
3. **装后端的 systemd 用户单元** `systemd/singbox-ext.service` 到
   `~/.config/systemd/user/`，然后 `systemctl --user daemon-reload`。安装时会把
   `ExecStart` 里的 `/usr/bin/env sing-box` 换成本机 sing-box 的**绝对路径**——
   装完还靠 PATH 找的话，跑起来的是哪一个取决于用户实例的环境，而 `setcap`
   只给了那一个二进制。
4. 检查可选的 `zbarimg`（二维码导入用）。

前三件都是幂等的，所以**第二次之后的安装不会再要密码**：脚本先自查一遍，都就位就
跳过 `pkexec`。要强制重做（例如手工删过 polkit 规则）：

```sh
FORCE_PRIVILEGED_SETUP=1 ./install.sh
```

⚠️ polkit 规则那一项不是靠「文件在不在」判断的——`/etc/polkit-1/rules.d` 是
`root:polkitd 0750`，普通用户连 `stat` 都不行。改成用 `pkcheck` 直接问 polkitd
「我现在有没有这个权限」，是功能验证而非代理指标：规则被删、被改窄、或写的是别的
用户，它都会如实返回未授权，于是重新请求授权。

## 后端是怎么跑起来的

扩展**自己不起任何进程**。sing-box 由 systemd 的用户实例托管：

```
点磁贴 → 扩展写 ~/.config/sing-box/ext/config.json（0600）
       → 会话总线 org.freedesktop.systemd1 → StartUnit("singbox-ext.service")
       → systemd 起 sing-box，扩展订阅 ActiveState，把状态映射回磁贴
```

单元刻意**不** `enable`（没有 `[Install] WantedBy=`）：它是按需启动的，开机不自启。
`Restart=no`：连接是用户按出来的，掉了就该在磁贴上显示成断开，而不是安静地重启循环。

几条随之而来的行为：

- **禁用扩展或重启 gnome-shell 不会断开连接**——后端归 systemd 管，活得比扩展久。
  扩展重新加载时会读一次单元状态，把磁贴同步成实际情况。要断开就点磁贴，或者
  `systemctl --user stop singbox-ext.service`。
- **单元没装时**点连接会提示「先运行 install.sh」，而不是一个看不懂的 D-Bus 报错。
- 后端起不来时通知里给的是 `journalctl --user -u singbox-ext.service`——日志现在在
  journal 里，扩展不再截取 sing-box 的 stderr。

常用命令：

```sh
systemctl --user status singbox-ext.service
journalctl --user -u singbox-ext.service -n 50
```

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

⚠️ meson 只装扩展本身。走这条路的话，`install.sh` 的另外两件事要手工做：把
`systemd/singbox-ext.service` 复制到 `~/.config/systemd/user/` 并
`systemctl --user daemon-reload`，以及跑一遍 `scripts/privileged-setup.sh`。

Install `zbarimg` from your distribution if QR image import is needed; the
preferences window says so explicitly when it is missing.

## TUN permissions

TUN 模式要能建网卡、改路由。这里给的是 sing-box 二进制的 capability，而不是
把谁提成 root：

```sh
sudo setcap cap_net_admin,cap_net_raw+ep "$(command -v sing-box)"
getcap "$(command -v sing-box)"
```

`install.sh` 的特权步骤已经做了这件事，上面那条只是手工核对/补做时用。生成的配置用
`auto_route`、`strict_route` 和 DNS 劫持。

⚠️ 后端的启动命令**不再是一项设置**。它写死在 `systemd/singbox-ext.service` 的
`ExecStart` 里，配置路径 `%h/.config/sing-box/ext/config.json` 与
`lib/singboxService.js` 的 `configPath()` 一一对应（`tests/service-test.js` 会对拍这两处）。
sing-box 装在非常规位置的话，改单元文件后 `systemctl --user daemon-reload`。

原来那个可编辑的「启动命令」输入框已经删掉：扩展执行来自设置的命令字符串是
extensions.gnome.org 明令禁止的，见下面的「上传到 extensions.gnome.org」。

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

## 上传到 extensions.gnome.org

```sh
./scripts/pack.sh      # 产出 singbox@anyfq.com.shell-extension.zip
```

**包里有的**（运行时全部家当）：

```
extension.js  prefs.js  metadata.json
lib/{config,fetch,singboxService}.js
icons/singbox-symbolic.svg
schemas/org.gnome.shell.extensions.gname-shell-extension-singbox.gschema.xml
locale/zh_CN/LC_MESSAGES/gname-shell-extension-singbox.mo
```

**包里没有的**（都是一次性的宿主机配置或开发资产，规则明确要求不要带）：

```
README.md  docs/  install.sh  scripts/  systemd/  tests/  po/  meson.build  .github/
```

`scripts/pack.sh` 用白名单验收包内容——黑名单会漏掉下次新加的目录。

`metadata.json` 里**没有** `version` 键：那个值由 extensions.gnome.org 分配，自己写
一个进去会被自动拒。`tests/run.sh` 现在会检查它不存在。

## Development

Pure logic — link parsing and configuration generation — lives in `lib/config.js`;
everything about the backend (unit name, config path, D-Bus calls) lives in
`lib/singboxService.js`. Neither imports `resource:///org/gnome/shell/*`, so both can
be tested outside a GNOME Shell session — the D-Bus layer with a fake bus object.

```sh
./tests/run.sh
```

The suite syntax-checks every source file, runs both unit test files under `gjs`,
compiles the GSettings schema, validates the translations, checks that no executable
command string has crept back into the settings, checks the systemd unit, and — when
`sing-box` is on `PATH` — feeds every generated configuration to `sing-box check`.
That last step is what keeps the generator honest against new sing-box releases.

### Translations

Source strings are English and live in `po/`. After changing any user-visible string:

```sh
./scripts/update-pot.sh
msgmerge --update po/zh_CN.po po/gname-shell-extension-singbox.pot
```

CI fails if the template is stale.
