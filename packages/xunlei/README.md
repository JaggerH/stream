# @streamapp/xunlei

迅雷字幕库在 Stream 里的知识。宿主不认识迅雷，只认识「`subtitle-search` 行上有个 `provides: [search-subtitle]` 的成员」。
（网盘那一侧的迅雷是另一回事，不在这个包里。）

## 管什么

| 东西 | 在哪 | 做什么 |
|---|---|---|
| 源 `xunlei-subtitle` | `manifests.yaml` | 视频文件名 → 字幕候选 |
| adapter `xunlei-subtitle` | `activate.ts` → `adapter.ts` | `op:'search'` 查、`op:'fetch'` 按 id 取字节 |
| 客户端 | `client.ts` | 接口地址、SxxExx 严格过滤、同名折叠、文件名语言线索、字幕 CDN 主机白名单 |

## 成员合同

宿主调两个操作：`op:'search'`（入参是视频文件名与大小，回候选列表 `{ id, name, nameHint, label }`）与
`op:'fetch'`（入参 `{ id }`，回字幕字节）。语言探测、srt/ass → VTT、排序都是宿主的事。本包的候选 `id` 就是字幕直链；宿主把它编进
`scrape:<源全名>:<base64url(id)>` 透传给前端，用户选中时再原样交回 `op:'fetch'`。取字节前本包自己校验主机
（id 可被客户端伪造，白名单是 SSRF 边界）。

## 实测约束

接口名字匹配宽松、必串台（查 S08E01 混进 S01E08）；`languages` / `score` 不可信。唯一可靠的过滤是从文件名
抽 SxxExx 严格比对（电影无 SxxExx 不过滤）。接口出错一律静默降级为空列表（它是没有内嵌轨、也没有外挂字幕时的
最后一条来源，失败不该挡住播放）。
