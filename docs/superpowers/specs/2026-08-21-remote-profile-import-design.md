# 远程 profile 导入设计

2026-08-21

## 背景

扩展目前只认单节点分享链接（`vless://`、`hysteria2://` 等），自己生成一份全局 TUN
配置。但 anyfq.com 的二维码里装的不是分享链接，而是 sing-box 官方的远程 profile 深链：

```
sing-box://import-remote-profile?url=<编码的 https URL>#🇬🇧 英国
```

原因在服务端注释里写着（`vpn-next/src/lib/singbox.ts`）：sing-box 官方 App 只认
`import-remote-profile`，不解析裸的 `hysteria2://`。所以想让扩展跟 anyfq.com 的
现有分发方式对得上，就必须支持这种深链。

拉取那个 URL 得到的是**一整份 sing-box 配置**，而不是一个节点。它的结构与扩展自己
生成的配置高度重合——同样的 TUN 入站（`172.19.0.1/30`、`auto_route`、`strict_route`、
`mixed`）、同样的 `sniff` + `hijack-dns` + `final: proxy` 骨架——但多了扩展无法从
分享链接推导出来的东西：

- `hop_interval`、`up_mbps`、`down_mbps` 等 hysteria2 调优参数
- `ip_is_private → direct` 分流规则
- 国内域名走 `223.5.5.5`（direct）、其余走 `1.1.1.1`（proxy）的 DNS 分流

## 前置修复（已完成）

服务端下发的配置此前用的是 sing-box 1.12 之前的 DNS 写法，在 1.12+ 上启动即 FATAL。
已修复并部署（`vpn-next` commit `b0ee48e`），线上端点验证 `sing-box check` 通过。

**这个修复消除了本设计原本需要的一整个模块。** 早期方案里有个 `lib/migrate.js`
负责把 legacy 构造升级到当前语法；服务端修好之后它没有存在价值了，故不做。

## 决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| 配置来源 | 存整份远程配置 | 只抽 outbound 会丢掉服务商的分流规则，国内域名解析会全部绕道境外 |
| 连接时机 | 用缓存立即连，连上后台静默刷新 | token 只有 24 小时有效期，每次连接前阻塞式重抓会在过期后天天弹假警报 |
| 抓取失败 | 静默忽略 | 服务端设计意图就是「token 只用于首次兑换，凭据拉到本地即长期可用」 |
| `insecure: true` | 原样保留 | 各节点自签证书且每台不同，后端没有统一 cert_pin，验证链路必然失败 |
| 配置迁移 | 不做 | 服务端已修；重复实现一遍上游的迁移逻辑是负债 |

## 数据模型

`links` 数组新增 `kind` 字段。**已有条目没有 `kind`，一律按 `'link'` 处理**，因此
现存连接零迁移。

```js
// 现有形态，保持不变
{ id, name, flag, url }

// 新增形态
{ id, kind: 'profile', name, flag,
  url,        // 内层 https URL，不是 sing-box:// 外壳
  config,     // 上次成功抓取的配置，原样存储
  fetchedAt } // ISO 时间戳
```

`config` 存原始响应而非加工后的版本：加工逻辑将来若有变化，缓存的配置自动跟着受益。

GSettings 里每条 profile 约 1.5 KB，量级无虞。

## 导入流程

1. 识别 `sing-box://import-remote-profile?url=…#<片段>`，取出内层 URL 与片段
2. 片段形如 `🇬🇧 英国`——**前导国旗 emoji 拆为 `flag`，其余为 `name`**，两个表单字段
   都可以留空
3. 抓取内层 URL，校验响应能解析为 JSON 且含 `outbounds`
4. 存库

**抓不到就拒绝导入。** 否则用户会存下一条从未验证过的订阅，直到某天连接失败才发现。

`isSupportedUrl` 相应放行 `sing-box://`，但**它必须走一条独立分支**：`addUrl` 现在
的做法是把 URL 原样存起来、留到连接时才交给 `buildSingBoxConfig` 生成配置，而
`sing-box://` 深链根本不是节点链接，喂给 `buildSingBoxConfig` 只会抛
`Unsupported protocol`。所以 `addUrl` 要先判断是不是深链：是就走上面的抓取流程存成
`kind: 'profile'`，否则维持原样。

QR 图片导入路径本身不变——它只是把解码出的字符串喂给同一个 `addUrl`。

## 连接流程

这是本设计唯一的架构改动。现在 `start()` 是同步的；引入网络之后 `SingBoxVpnManager`
需要一个显式状态机：

```
idle ──start(profile)──> 写缓存配置 ──> running ──后台刷新──> 更新缓存（不影响本次连接）
                                          │
idle ──start(profile)──> 无缓存 ──抓取──> fetching ──成功──> running
                                          │  失败 ──> 通知错误 ──> idle
                                          └── stop() ──> 取消请求 ──> idle
```

有缓存时**不阻塞**：直接写盘启动，与现有分享链接路径的体感一致。只有从未成功抓取过
的 profile（正常导入流程保证不会出现，但缓存可能被外部清空）才走阻塞抓取，此时开关
显示「正在获取配置…」。

后台刷新的结果只写回 GSettings，**绝不触碰正在运行的进程**——静默刷新导致重连是
用户完全无法理解的行为。

风险点在中间态：抓取期间用户再次点击开关、或注销触发 `disable()`，都必须能干净取消
（`Gio.Cancellable`），不留野回调。

HTTP 用 `gi://Soup`（libsoup 3，GNOME Shell 自带），带超时。

## 错误处理

| 情况 | 行为 |
|---|---|
| 导入时抓取失败 | 拒绝导入并说明原因 |
| 连接时有缓存 | 直接用，后台刷新失败静默忽略 |
| 连接时无缓存且抓取失败 | 通知错误，回到 idle |
| 响应不是合法配置 | 等同抓取失败 |
| 配置本身有问题 | 交给 sing-box，经现有 stderr 上报路径显示 FATAL 行 |

## 测试策略

延续现有做法：**逻辑放纯函数，网络层保持极薄且不做单元测试。**

新增纯函数与对应测试：

- `parseRemoteProfileLink(url)` → `{url, name, flag}`，覆盖片段缺失、无 emoji、
  URL 编码等情形
- `isValidRemoteConfig(json)` → 布尔，覆盖非 JSON、缺 `outbounds`、空数组

新增 fixture：一份**脱敏的**真实 anyfq 配置（真实结构、假凭据），断言它能通过
`tests/run.sh` 里已有的真实 `sing-box check`。

## 安全与隐私

整份配置含密码与 obfs 密钥，明文存进 GSettings/dconf。**这与现状没有变化**——现有
分享链接的密码本来就明文存在同一个地方。本次不引入加密；记录在此是为了让这个事实
是被知道的，而不是被忽略的。

profile 的 `url` 内含 24 小时有效的 token。它随配置一起存储，过期后即失去价值。

## 明确不做

- **手动刷新按钮**：既然连接后自动后台刷新，它没有存在价值
- **订阅自动更新计划任务**：连接时刷新已经覆盖真实使用场景
- **多节点 profile 的节点选择 UI**：anyfq.com 按地区各发一份单节点配置，一张 QR
  对应列表里一条连接。等真的遇到多出站的 profile 再说
- **配置迁移层**：见上文
