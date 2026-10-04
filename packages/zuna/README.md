## 说明

music.znnu.com — 一个第三方网易云解析站。它的 API 对请求签名（HMAC-SHA256）、对响应加密
（AES-256-GCM），recipe 把这两段作为 PURE compute 片段带着，在零能力的 isolated-vm 堆里跑。
它**不是平台**，所以不碰红线（碰红线的是 iqiyi）。

## 四份 recipe

四份都是 `kind:'http'` + compute 钩子（沙箱里签名 + 解密），一次请求拿一份结果：

| recipe | 干什么 | 谁在用 |
|---|---|---|
| `zuna-search` | 关键词 → 歌曲 | `music-search` 行的并发成员（与 `toubiec-search` 并列） |
| `zuna-download` | song id → 可播放/可下载地址 | `netease-track` 梯子（radar `music.163.com/song`，排在 toubiec 之后） |
| `zuna-playlist` | 歌单 id → 整份曲目名单 | radar `music.163.com/playlist` |
| `zuna-album` | 专辑 id → 整张曲目名单 | radar `music.163.com/album` |

除 `zuna-download` 外，结果 item 的 link 都回到 `music.163.com/song?id=`——每首歌的真实文件
地址在播放/下载那一刻由 `netease-track` 现解，名单本身不预解析。

## 上游现状：整站 500

2026-08-25 实测：`/api/song`、`/api/search`、`/api/playlist` 一律 `500 服务器内部错误`，每发
约 15s，**在 music.znnu.com 自己的页面上点「开始解析」拿到的也是同一个 500**。

**别去改我们这一侧。** 逐项核过：前端 bundle 里的 HMAC 密钥就是 recipe 里那把
（`a09d0f37…`），签名算法、参数集、请求头一字不差，签名是**过的**——过不了才回 401。
这是上游自己的故障，等它修。同一条梯子上 toubiec 是健康的那一档。

`zuna-album` 是照 `zuna-playlist` 的形状对称写出来的（参数取自它前端 `/api/album` 的调用点），
**在上游恢复之前没能跑通过一次**——它是这四份里唯一没有活体证据的。
