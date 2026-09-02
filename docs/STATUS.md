# 状态与待办

最后更新：2026-09-02（EGO 自动拒绝后的改造：后端搬到 systemd 用户单元）

这个仓库是 [anyfq.com / vpn-next](https://github.com/) 的**子项目**。主干工作在 vpn-next，
这里跟随。两边的契约写在 vpn-next 的 `CLAUDE.md`「与 Ext-SingBox 的交互」一节。

## EGO 拒绝原因与本次改法（2026-09-02）

上传 extensions.gnome.org 被**自动拒**。四条原因和对应的改法：

| # | 拒绝原因 | 改法 |
|---|---|---|
| 1 | `extension.js` 把 GSettings 里的 `backend-command` 用 `GLib.shell_parse_argv` 解析后 `Gio.Subprocess.new` 执行，还在 gnome-shell 进程里管着一个长期运行的 VPN 守护进程 | 后端改成 systemd **用户单元** `singbox-ext.service`，扩展只通过**会话总线**发 `StartUnit`/`StopUnit`，订阅 `ActiveState`。新增 `lib/singboxService.js`，仿 tor-ext 的 `lib/torService.js` |
| 2 | `metadata.json` 里有 `"version": 1` | 删掉。这个值由 EGO 分配；`tests/run.sh` 现在检查它**不存在**（原来的检查恰好要求它存在，把错误锁死了） |
| 3 | zip 里带着 `README.md` | 新增 `scripts/pack.sh`，用 `gnome-extensions pack` 只收运行时文件，再用**白名单**验收包内容 |
| 4 | `extension.js` 的 `GLib.chmod`，以及描述里教用户跑 `sudo setcap` | 配置改成「创建时就带对权限」：目录走 `mkdir(0700)`，文件走 `Gio.FileCreateFlags.PRIVATE` + `REPLACE_DESTINATION`。描述改成「后端是项目安装脚本装好的 systemd 用户服务」，不再出现 `sudo …` |

### 新的运行方式

```
点磁贴 → writeConfig() 写 ~/.config/sing-box/ext/config.json（0600）
       → 会话总线 org.freedesktop.systemd1 → StartUnit("singbox-ext.service")
       → systemd 起 sing-box；PropertiesChanged 的 ActiveState 回来后刷磁贴
```

- 用户实例**不需要 polkit**：调用者就是单元的所有者。（tor-ext 那套 polkit 规则是给
  跑在 root 下的系统单元用的，两码事。）DNS 免密那条 polkit 规则仍然要，原因没变。
- 单元没有 `[Install] WantedBy=`，`Restart=no`，`KillSignal=SIGINT`。
- **禁用扩展不再断开连接**——后端归 systemd 管。扩展加载时读一次单元状态，
  用 `last-link-id` 还原是哪一条，把磁贴同步成实际情况。

### 几个踩到的点

- `Manager.Subscribe()` **不能省**：systemd 只向调用过它的客户端广播单元属性变化。
  不调的话一条 `PropertiesChanged` 都收不到，症状是「连上了但磁贴不动」。
  测试里专门有一条锁住它。
- `GetUnit` 只认**已经加载进内存**的单元，第一次连接必然失败，要落到 `LoadUnit`；
  而 `LoadUnit` 对根本不存在的单元也成功（`LoadState` 是 `not-found`），所以
  「装没装」只能看 `LoadState`，不能看调用成不成功。
- 换服务器要 `RestartUnit`，中间必然经过 `deactivating/inactive`。不挡的话会弹一条
  假的「已断开」。用一个 `_starting` 闸门挡住，看到 `active`/`failed` 才落闸。
- 文件权限：只写 `PRIVATE` 是**不够的**——替换已存在的文件时若不带
  `REPLACE_DESTINATION`，Gio 走的是就地截断，沿用旧文件的权限位，PRIVATE 等于没写。
  `tests/service-test.js` 里那条「重写一个 0644 的文件后仍是 0600」就是为它写的，
  去掉任一标志都会红。
- `tests/run.sh` 新加的「设置里不许有可执行字符串」这条检查，第一版被**自己的注释**
  打红了——注释里写着 `shell_parse_argv` 这个词。数活跃项之前先剔注释，这个仓库
  在别处栽过反过来的同一跤。

### 还没验证的

- **没有在真实 GNOME 会话里跑过**（本次改造）。已验证的是：14 条新单元测试（含对
  D-Bus 调用形状的断言与三次变异检验）、`tests/run.sh` 全绿、`scripts/pack.sh` 产出的
  包内容干净。真机验收要看的是：单元装上后点磁贴能连、切换服务器不弹假断开通知、
  禁用扩展后连接仍在。
- EGO 那边只有重新上传才知道结论。zip 已按新规则重打，文件名不变。

## 现在能做什么

- 导入 `vless://` / `vmess://` / `trojan://` / `ss://` / `hysteria2://`（含 `hy2://`）分享链接
- 导入二维码图片（需要 `zbarimg`，Ubuntu 上是 `zbar-tools` 包）
- 导入 `sing-box://import-remote-profile` 订阅深链，抓取并缓存整份配置
- 从快捷设置面板一键连接（启停的是 systemd 用户单元 `singbox-ext.service`）
- 后端异常退出会发通知，内容是 `journalctl --user -u singbox-ext.service`
  ——⚠️ 原来这里写「把 sing-box 的 FATAL 行报进通知」，那条路径 2026-09-02 起没有了：
  stderr 归 journal，扩展读不到

## 已验证 / 未验证

**已自动验证**（`./tests/run.sh`，CI 同样跑）

- 74 个单元测试：`tests/config-test.js` 60 条（链接解析、配置生成、订阅深链解析、
  响应校验）+ `tests/service-test.js` 14 条（配置文件权限、systemd D-Bus 调用形状）。
  ⚠️ 原来这里写「51 个」并含「失败信息提取」——那组测试随 `describeProcessFailure`
  一起删了：stderr 现在归 journal，扩展读不到，留着就是无人调用的死代码
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

⚠️ 上面两条是 **2026-08-21 的快照，已过时**：2026-09-02 起 meson **不再装 README.md**
（扩展目录里只放运行时文件），并且多装一个 `lib/singboxService.js`。meson 也**不装**
后端的 systemd 用户单元——走那条路要手工补 `install.sh` 的另外两件事。
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

根因不在扩展代码——当时的 `stop()` 就是个 `send_signal(15)`，全仓库没有一处 pkexec。
（2026-09-02 起 `stop()` 改成对 systemd 用户单元发 `StopUnit`，这段结论不受影响：
弹窗来自 sing-box 调 resolve1，跟谁来启停它无关。）
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

改了任何用户可见字符串之后，必须重新生成翻译模板。⚠️ 这里原来写着「`tests/run.sh`
只跑 `msgfmt --check`，不校验 `.pot` 新鲜度，所以本地全绿也可能 CI 失败」——**已过时**：
本地那步（`== Translation template`）和 CI 跑的是同一条 `scripts/update-pot.sh`，
模板过期本地就会红，不会等到 CI。

```sh
./scripts/update-pot.sh
msgmerge --quiet --update --backup=none po/zh_CN.po po/gname-shell-extension-singbox.pot
```

## 设计文档

- `docs/superpowers/specs/2026-08-21-remote-profile-import-design.md` — 订阅导入的设计与决策记录
- `docs/superpowers/plans/2026-08-21-remote-profile-import.md` — 对应的实现计划
