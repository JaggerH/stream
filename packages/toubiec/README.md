## 说明

nextmusic.toubiec.cn — 另一个第三方网易云解析站（公开入口是 wyapi.toubiec.cn）。和 zuna 不同，
它**不签名也不加密**：全是明文 JSON POST，所以这几份都是纯 http recipe，compute 只用来拼 body。

## 三份 recipe

| recipe | 干什么 | 谁在用 |
|---|---|---|
| `toubiec-search` | 关键词 → 歌曲 | `music-search` 行的并发成员（与 `zuna-search` 并列） |
| `toubiec-download` | song id → 可播放/可下载地址 | `netease-track` 梯子首档（radar `music.163.com/song`） |
| `toubiec-playlist` | 歌单 id → 整份曲目名单 | radar `music.163.com/playlist` |

搜索与歌单的 item link 回到 `music.163.com/song?id=`——文件地址在播放/下载那一刻由
`netease-track` 现解。

## 每个请求都必须带 `ip`

上游校验的是**调用方自报的公网 IP**：少了这个字段一律回 `400 当前非法提交参数`，空串回
`参数 ip 不能为空`。所以每份 recipe 都先 prefetch 它自己的 `/api/ip`，再由 `sign` 把值拼进 body
（它的前端就是这么做的）。

实测边界（2026-08-25）：`timestamp` 反过来**根本不校验**（传 `1` 也过），`ip` 只校验非空
（`0.0.0.0` 也收）——**没有签名可逆**，只是两个明文字段。

## `toubiec-download` 的元数据来自网易云自己

`getSongUrl` 只回地址、码率、大小，不带歌名歌手专辑封面；而下游要拿这些写进音频文件的 ID3
标签。所以这份 recipe 另外 prefetch 一次 `music.163.com/api/song/detail`（免鉴权，且它本来就是
这些字段的权威出处），在 decode 里并进结果。

不用上游的 `getSongInfo` 是有原因的：它同样要 `ip`，而 prefetch 之间取不到彼此的结果
（`http-fetch.ts` 的 prefetch 只吃 `params`），拿不到真实 IP 就只能编一个。

## 专辑：上游自己坏了，没有对应 recipe

`getAlbum` 恒回 `code -462 Failed to fetch album`（四个不同专辑 id 全同），它前端的解析类型
也只剩「单曲」一档。等它修好再补。
