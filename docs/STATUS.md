# 状态与待办

最后更新：2026-08-21（meson 路径已实测，两处已知问题已修）

这个仓库是 [anyfq.com / vpn-next](https://github.com/) 的**子项目**。主干工作在 vpn-next，
这里跟随。两边的契约写在 vpn-next 的 `CLAUDE.md`「与 Ext-SingBox 的交互」一节。

## 现在能做什么

- 导入 `vless://` / `vmess://` / `trojan://` / `ss://` / `hysteria2://`（含 `hy2://`）分享链接
- 导入二维码图片（需要 `zbarimg`，Ubuntu 上是 `zbar-tools` 包）
- 导入 `sing-box://import-remote-profile` 订阅深链，抓取并缓存整份配置
- 从快捷设置面板一键连接；后端启动失败会把 sing-box 的 FATAL 行报进通知

## 已验证 / 未验证

**已自动验证**（`./tests/run.sh`，CI 同样跑）

- 51 个单元测试：链接解析、配置生成、订阅深链解析、响应校验、失败信息提取
- 每一份生成的配置都喂给**真实 `sing-box check`**——这是最重要的一层，它挡住的正是
  2026-08-21 那个把服务端配置写成 1.12 前 DNS 格式、导致启动即 FATAL 的问题
- `tests/fixtures/anyfq-uk.json` 是**脱敏的 anyfq.com 真实响应**（真实结构、假凭据），
  同样过 `sing-box check`。服务端改配置结构时必须同步更新它，否则这边测试继续绿、线上会坏

**已手工实测一次**（不在 CI 里，因为 CI 环境没有 meson）

- `meson setup` + `meson install --prefix=<临时目录>` 走通，装出来的 10 个文件齐全：
  `metadata.json` / `extension.js` / `prefs.js` / `lib/{config,fetch}.js` /
  `icons/singbox-symbolic.svg` / schema 的 xml 与**编译出的 `gschemas.compiled`（407 字节）**/
  `locale/zh_CN/.../*.mo` / `README.md`。代码里 `from './...'` 引到的本地文件逐个核对都在。
- 与 `install.sh` 机械对比：两条路径装的东西一致，meson 只多一个 README.md。
- ⚠️ 这只证明**装得对**，不证明装完能跑——「装完在真实会话里能不能连」仍属下面的未验证项。

**已在真实 GNOME 会话里跑通**（2026-08-21）

1. **从快捷设置的订阅条目连接** —— profile 分支的 `_writeConfig` 已真正执行过。
2. **完整导入链路** —— 扫码 → 落库 → 连接 → 后台刷新，端到端走通。

过程中暴露并已修掉三个独立问题，都不是靠代码审查能发现的：

| 现象 | 根因 | 归属 |
|---|---|---|
| 连接弹三次密码、断开一次 | sing-box 非 root，resolve1 每个方法各要一次 polkit 授权 | 系统策略，见下方「密码弹窗」 |
| 连接报「不支持的协议 https」 | **装在系统里的 `extension.js` 是旧版**，没有 profile 分支 | 本机安装，非代码 |
| 连上后 sing-box 启动即 FATAL | 服务端下发的配置里 `dns.servers[local].detour` 在 1.13 被拒 | vpn-next 生产，影响所有客户端 |

⚠️ 第二条值得单独记：`prefs.js` 已经带二维码导入、`extension.js` 却还没带订阅连接，
`lib/*.js` 反而一致——于是能导进来、一点就炸，表象极像代码 bug。**排查任何「代码
明明写了却不生效」之前，先 `cmp` 一遍装的那份和仓库那份**，这比 GJS 模块缓存更能骗人。

⚠️ 第三条的教训是测试分层：`sing-box check` 对那份坏配置是**绿的**。check 只验配置
能不能被解析，不验服务能不能起来。vpn-next 那边已补了一条真的 `run` 的测试。

### 二维码实测（2026-08-21）

拿站点导出的真实二维码 `ViPiN-US.png` 跑了导入链路里所有不依赖 GNOME 的环节，
用的都是 `lib/config.js` 里的**同一份函数**，不是另写的等价实现：

| 环节 | 结果 |
|---|---|
| 二维码解码（zbar 与 opencv 各一次，结果一致） | ✅ `sing-box://import-remote-profile` |
| `parseRemoteProfileLink` 取内层 URL | ✅ |
| fragment 自动填充 | ✅ `flag: 🇺🇸`、`name: 美国` —— 深链契约成立 |
| 抓取内层 URL | ✅ HTTP 200，1538 字节 |
| `isValidRemoteConfig` | ✅ `ok: true`，`outbounds: hysteria2, direct` |
| 真实 `sing-box check`（1.13.19） | ✅ 通过 |
| 真实响应 vs `tests/fixtures/anyfq-uk.json` 的键路径 | ✅ **42 : 42，两边差集均为空** |

最后一行是这次最有价值的一条：它证明 fixture **此刻没有相对服务端漂移**，
也就是上面担心的「测试继续绿、线上会坏」目前不成立。服务端下发的 `dns.servers`
已是 1.12+ 的 `type: udp` 写法，与 fixture 一致。

⚠️ 这条比对是**某一时刻的快照**，不是一道会自动报警的闸门。服务端下次改
`src/lib/singbox.ts` 的结构时，仍然必须手工同步这份 fixture。

⚠️ **GJS 缓存 ESM 模块**：改完 `extension.js` 后 `gnome-extensions disable/enable`
**不会重新加载代码**，Wayland 下必须注销重新登录。症状是「改了没生效」，极容易误判成
代码写错了。`prefs.js` 不受影响，每次开窗口都是新进程。

## 密码弹窗（2026-08-21 已修）

首次真机试用时：**连接要输三次密码，断开再输一次**。

根因不在扩展代码——`stop()` 就是个 `send_signal(15)`，全仓库没有一处 pkexec。
弹窗来自 sing-box：它以普通用户身份运行（`setcap` 只给了两个网络 capability，
没给 root），而要通过 DBus 让 systemd-resolved 把 DNS 指进隧道。journal 的时序
把因果钉死了，每次弹窗后面紧跟着一条 resolved 的日志：

```
10:40:13  singbox0 网卡建好                        → polkit-agent-helper@23
10:40:22  singbox0: set search domain list to: ~.  → polkit-agent-helper@24
10:40:26  singbox0: set default route setting: yes → polkit-agent-helper@25
10:40:31  singbox0: set DNS server list to: …
10:40:43  （断开，RevertLink）                      → polkit-agent-helper@26
```

resolve1 的每个方法都是独立 action，默认 `auth_admin_keep`，而「记住」按 action
记，所以三个方法记不住彼此。

**修法**：安装时写一条 polkit 规则放行这些 action。取舍与删除方法写在 README。
选它而不是「改成 root 跑的 systemd 服务」，是因为后者虽然免密授权范围窄得多
（只放行启停一个单元），却要把 sing-box 从非特权进程提成 root——它是直接解析
网络对端数据的程序，root 身份的爆炸半径大得多。

⚠️ 系统里没有任何给 root 开的 polkit 后门（`50-default.rules` 只定义管理员身份
是 `unix-group:sudo`）。root 不弹窗是因为 systemd 在调 polkit 之前先查发起者
权限、uid 0 直接判过——别把这理解成 polkit 对 root 网开一面。

## 已知的小问题（最终审查判定为可以先发）

- ~~后台刷新的 `cancel()` 拦不住已完成、回调已排进主循环的请求~~ **已修**：
  `destroy()` 里把 `this._settings` 置空，刷新回调开头 `if (!this._settings) return;`。
  destroy 之后那个回调不再写 dconf。
- `stop()` 不取消在途刷新——这是**刻意的**，不是遗漏。刷新与运行中的进程无关，让它跑完
  能为下次缓存更新的配置；`destroy()` 会取消，那才是 gnome-shell 里真正要紧的场景。
  代码里有注释说明，别把它「修」掉。
- ~~首选项窗口关闭后，导入的抓取回调仍可能触发（最长 20 秒）~~ **已修**：
  窗口挂了 `close-request` 取消器，导入用的 `fetchText` 改为传这个 Cancellable。
  `fetchText` 在 `Gio.IOErrorEnum.CANCELLED` 时**整个不回调**，所以取消即彻底关闭。
- spec 里写的 `fetching` 阻塞态没有实现——无缓存的 profile 直接抛错而不是阻塞抓取。
  实际不可达（缓存在 GSettings 里，不是缓存目录），属于有意简化。

## 常用命令

```sh
./tests/run.sh    # 语法检查 + gjs 单测 + schema 编译 + 翻译校验 + 真实 sing-box check
./install.sh      # 装到 ~/.local/share/gnome-shell/extensions/，会提示缺失的 zbarimg
```

改了任何用户可见字符串之后，必须重新生成翻译模板，否则 **CI 会红**（`tests/run.sh`
只跑 `msgfmt --check`，不校验 `.pot` 新鲜度，所以本地全绿也可能 CI 失败）：

```sh
xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ \
  --package-name="sing-box Link Manager" --package-version=1 \
  --copyright-holder="sing-box Link Manager contributors" \
  --msgid-bugs-address="https://github.com/gname/gname-shell-extension-singbox/issues" \
  -f po/POTFILES.in -o po/gname-shell-extension-singbox.pot
msgmerge --quiet --update --backup=none po/zh_CN.po po/gname-shell-extension-singbox.pot
```

## 设计文档

- `docs/superpowers/specs/2026-08-21-remote-profile-import-design.md` — 订阅导入的设计与决策记录
- `docs/superpowers/plans/2026-08-21-remote-profile-import.md` — 对应的实现计划
