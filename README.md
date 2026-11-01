# Zayu · 项目交接说明

> 这份文档是给「未来接手这个项目的 AI / 人」看的。
> 如果你完全不了解这个项目，读完它就能知道：项目是什么、怎么跑、怎么改、怎么部署、改完怎么验证。

---

## 一、项目是什么

一个**纯前端网页聊天应用**，模拟和一个「角色」聊天。
核心体验是：对方会主动发消息、来信、打语音电话、邀请陪伴、邀请听歌、发朋友圈、写信——而且在你把网页放到后台、锁屏、切到抖音之后，**仍然能收到系统通知**。

- **访问地址**：https://zayun.pages.dev
- **使用方式**：在手机 Safari 打开上面的链接 → 「添加到主屏幕」→ 当 App 用
- **已验证机型**：iPad 11（iOS，添加到主屏幕模式）全功能通过
- **目标用户手机**：后续会换到 iPhone，已做 `safe-area` / `100dvh` / `viewport-fit=cover` 适配

---

## 二、代码仓库 & 部署

### 仓库
- GitHub：`https://github.com/cloud-8-alt/Zayun`
- 分支：`main`
- 仓库根目录关键文件：
  - `index.html`（本地开发时叫 `Zayu.html`，**部署时改名为 `index.html` 推上去**）—— 整个应用的单文件 HTML（CSS + JS 全在里面）
  - `sw.js` —— Service Worker，处理 Web Push 推送和通知点击
  - `functions/api/[[path]].js` —— Cloudflare Pages Functions，所有 `/api/*` 接口
  - `worker_push.js` —— 独立的 Cloudflare Worker，每分钟跑一次兜底推送
  - `keepalive.mp3` —— 5 分钟静音音频，后台保活用
  - `manifest.webmanifest` —— PWA 清单
  - `icon-*.png` —— 图标（192 / 512）

### 部署方式
1. 把本地 `Zayu.html` 重命名为 `index.html`
2. 连同 `sw.js`、`functions/`、`worker_push.js`、`keepalive.mp3`、`manifest`、图标一起 `git push` 到 `main`
3. Cloudflare Pages 自动构建，几分钟后 `https://zayun.pages.dev` 就是新版本
4. **`worker_push.js` 不会随 Pages 自动部署**，需要单独用 Cloudflare API 上传（见第六节）

---

## 三、用到的云服务（全部免费额度内）

### 1. Cloudflare Pages（网页托管）
- 项目名：`zayun`
- 域名：`zayun.pages.dev`
- 构建命令：无（纯静态）
- Functions 入口：`functions/api/[[path]].js`
- Pages Functions 用到的环境变量（在 Cloudflare 控制台 → Pages → zayu → Settings → Environment variables 里设置）：
  - `KV` —— 绑定 KV 命名空间 `zayu-storage`（KV namespace binding）
  - `CFS_KEY`、`CFS_EMAIL`、`CFS_TOKEN`、`CF_ZONE_ID` —— 调用 Cloudflare API 用（只在 Worker 里用，Functions 不需要）

### 2. Cloudflare Worker（每分钟兜底推送）
- Worker 名：`push-hedge`
- 触发：Cron `*/1 * * * *`（每分钟一次）
- 绑定 KV：`zayu-push`
- 环境变量 / Secrets（在 Worker 控制台 → Settings → Variables）：
  - `CFS_KEY`：Cloudflare API Key
  - `CFS_EMAIL`：Cloudflare 登录邮箱
  - `CFS_TOKEN`：Cloudflare API Token（带 Workers KV 写权限）
  - `CF_ZONE_ID`：zayun.pages.dev 所在 Zone ID
  - 绑定 KV namespace `zayu-push` 到变量名 `KV`

### 3. Cloudflare KV（两个命名空间）
- `zayu-storage`：存用户数据备份（通过 Pages Functions 读写）
  - Key 格式：`b:<endpoint>` —— 备份数据
  - Key 格式：`r:<recoveryCode>` —— 恢复码 → endpoint 的映射
- `zayu-push`：存推送订阅、预排程、心跳（通过 Worker 读写）
  - `s:<endpoint>` —— Web Push 订阅信息（expiration 365 天）
  - `p:<endpoint>` —— 预排程的消息/事件数组（expiration 7 天）
  - `a:<endpoint>` —— 最后心跳时间戳（expiration 600 秒）
  - `g:<endpoint>` —— 宽限窗口（毫秒），默认 `300000`（5 分钟）；被音频打断时设为 `10800000`（3 小时）
  - `z:<endpoint>` —— 同步日志，防重复（本地 localStorage 也有一份）

> ⚠️ **千万不要把密钥值写进代码或 README**。上面这些只是变量名，真实值在 Cloudflare 控制台里。

---

## 四、核心功能与实现要点

### 4.1 后台保活
- 播放一段 5 分钟的静音音频 `keepalive.mp3`，循环播放
- 用 `MediaSession` API 设置锁屏卡片（显示「Zayu 后台运行中」）
- 音频被其他 App（抖音/视频/微信语音）抢走时触发 `pause` 事件 → 通知服务器把兜底窗口放宽到 3 小时
- 页面自己活着的时候，**通知由页面直接弹**，不走云端

### 4.2 消息通知（最重要）
- 每条消息一个独立 `tag`，`silent: true`（静音），不合并、不震动
- 页面活着：直接 `new Notification(...)`
- 页面冻结（划掉/被系统回收）：Worker 每分钟检查预排程，到点的项目发 Web Push，Service Worker 接收后拉 `/api/pending` 取明细逐条弹

### 4.3 来电 / 陪伴 / 听歌邀请
- **来电**：
  - 全屏来电页 + 常驻状态栏通知（`requireInteraction: true`）
  - 安卓被系统吞通知时，每 30 秒自动重发一次
  - 通知带「接听 / 挂断」按钮，点击回传 Service Worker → 转页面处理
  - 云端预排程里也有来电，页面冻结时仍能被叫，通知同样常驻
- **陪伴 / 听歌邀请**：
  - 页面内触发：插一条系统消息 + 普通通知
  - 云端触发（页面冻结时）：常驻通知
- 概率（与原代码一致，未调高）：
  - 主动消息 tick：每分钟每类 **1.5%**
  - 每轮回复开始 / 结束：每类 **3%**
  - 云端预排程每 5 分钟一格：`1 - (1 - 0.015)^5 ≈ 7.3%`（数学上等于每分钟 1.5%）

### 4.4 朋友圈 / 写信
- `schedulePartnerMoments` 每小时跑一次，回前台补跑
- 信件调度独立
- **不受「角色主动发消息」开关限制**
- 页面被冻结期间不产生，回前台补跑

### 4.5 划掉应用后的行为
- 进程被杀 → 心跳停止 → 服务器 5 分钟内清空预排程 → 彻底不再推送
- 这是为了满足「划掉就别发消息」的需求
- 但代价：如果刷抖音超过 5 分钟且音频被抢，也会被判定为「划掉」（无法区分）
- 音频被抢时页面会发信号把窗口放宽到 3 小时，所以刷抖音短时间内仍有兜底

### 4.6 数据存储
- **本地**：IndexedDB 存全部聊天记录、设置、角色信息
- **每日快照**：本地保留最近 7 天
- **云端备份**：每天自动 + 手动「立即备份」，存到 KV `zayu-storage`，TTL 730 天（2 年）
- **恢复码**：6 位字母数字，对应 KV 里的 `r:<code>` → endpoint 映射
- 「持久化存储」权限已申请，避免浏览器自动清理

---

## 五、接口清单（`functions/api/[[path]].js`）

| 路径 | 方法 | 作用 |
|---|---|---|
| `/api/health` | GET | 健康检查，返回 `{ok, ts, mode}` |
| `/api/sub` | POST | 上传 Web Push 订阅信息到 KV |
| `/api/unsub` | POST | 删除订阅 |
| `/api/plan` | POST | 上传预排程（消息/来电/陪伴/听歌） |
| `/api/alive` | POST | 心跳（页面活着时每 75 秒一次） |
| `/api/grace` | POST | 设置宽限窗口（音频被抢时 3 小时，否则 5 分钟） |
| `/api/pending` | GET | Service Worker 拉取待推送明细 |
| `/api/push` | POST | 服务器推送测试 |
| `/api/backup` | POST | 上传云端备份 |
| `/api/backup/:code` | GET | 用恢复码取备份 |
| `/api/recovery` | POST | 生成 / 取恢复码 |

---

## 六、怎么改 Worker（`worker_push.js`）

Pages 的 `functions/` 会自动部署，但 **`worker_push.js` 必须手动上传**，否则定时任务不会更新。

上传方式（在本地终端）：

```bash
# 需要设置环境变量（值在 Cloudflare 控制台 → My Profile → API Tokens）
export CF_API_TOKEN=你的token
export CF_ACCOUNT_ID=你的账户ID

# 上传 Worker 代码
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/scripts/push-hedge" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/javascript" \
  --data-binary @worker_push.js
```

上传后到 Cloudflare 控制台 → Workers → `push-hedge` → Triggers 确认 Cron 还在（`*/1 * * * *`）。

> ⚠️ 重新上传 Worker 不会丢失已设的 Secrets（密钥独立于代码保存），但 KV 绑定需要确认还在。

---

## 七、改完代码后的验证清单

每次改完并部署后，按顺序验：

1. `curl https://zayun.pages.dev/api/health` → 返回 `{"ok":true,...}`
2. 手机端打开页面 → 设置 → 新消息提醒 → 确认「云端推送：已订阅」
3. 点「测试推送」→ 立刻弹通知
4. 点「服务器推送测试」→ 弹通知（这条走的是 Worker 兜底路径）
5. 划掉应用 → 等 10 分钟 → 应该安静（不再有主动消息）
6. 重新打开 → 通知恢复
7. 切后台打开抖音 10 分钟 → 回来看是否收到过通知
8. 设置 → 数据 → 立即备份 → 显示「备份成功」

---

## 八、常见问题速查

**Q: 部署后手机还是旧版本？**
A: 从任务栏彻底划掉应用，再重新打开。或在 Safari 里清缓存。

**Q: 划掉应用后还有通知？**
A: 可能是划掉时 iOS 也触发了音频 `pause` 事件，被误判成「被抢音频」。检查 `g:<endpoint>` 的值是不是 `10800000`。如果是，把 `buildPlan` 里的 grace 强制设回 `300000`。

**Q: 云端预排程不推送？**
A: 1) 确认 Worker `push-hedge` 的 Cron 还在跑；2) 确认 KV 绑定 `zayu-push` 还在；3) 看 `a:<endpoint>` 心跳时间戳是否在 2 分钟内（如果在，Worker 会跳过）。

**Q: 来电通知不常驻？**
A: 检查 `sw.js` 里 `showNotification` 是否带了 `requireInteraction: true`。

**Q: KV 写入超限（免费版每天 1000 次）？**
A: 页面 24 小时挂着会超。解决：1) 升级 Workers 付费（$5/月）；2) 把心跳间隔从 75 秒改大，或把预排程间隔从 5 分钟改大。

---

## 九、用户的核心诉求（别改反了）

1. **消息通知一定要稳定** —— 后台、锁屏、刷抖音都要能收到
2. **来电一定要显眼** —— 全屏 + 常驻，不接不挂就一直响
3. **划掉应用 = 停止一切推送** —— 不管主动发消息开关开没开
4. **朋友圈、写信不受主动发消息开关限制**
5. **来电 / 陪伴 / 听歌不受主动发消息开关限制，也不受刷抖音影响**
6. **数据不能丢** —— 本地 + 云端双备份 + 恢复码
7. **链接要稳定** —— 不要 404，不要突然打不开
8. **iPhone 适配** —— 刘海、灵动岛、home 条不能挡

---

*最后更新：2026-11-02*
