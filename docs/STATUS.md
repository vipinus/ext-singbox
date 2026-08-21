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

**未验证 —— 需要人工在真实 GNOME 会话里跑**（这两条无法自动化）

1. **注销重新登录后，点快捷设置里的订阅条目连接。** profile 分支的 `_writeConfig`
   至今没有被任何人真正执行过，只做过代码审查和离线逻辑验证。
2. **用一张没过期的新二维码走完整导入。** 抓取 → 校验 → 落库 → 连接 → 后台刷新
   这条端到端链路整体没跑过。二维码里的 token 只有 24 小时有效期。

⚠️ **GJS 缓存 ESM 模块**：改完 `extension.js` 后 `gnome-extensions disable/enable`
**不会重新加载代码**，Wayland 下必须注销重新登录。症状是「改了没生效」，极容易误判成
代码写错了。`prefs.js` 不受影响，每次开窗口都是新进程。

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
