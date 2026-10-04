# @streamapp/shooter

射手字幕库在 Stream 里的知识。宿主不认识射手，只认识「`subtitle-search` 行上有个 `provides: [search-subtitle]` 的成员」。

## 管什么

| 东西 | 在哪 | 做什么 |
|---|---|---|
| 源 `shooter-subtitle` | `manifests.yaml` | 视频内容指纹 → 字幕候选 |
| adapter `shooter-subtitle` | `activate.ts` → `adapter.ts` | `op:'search'` 查、`op:'fetch'` 按 id 取字节 |
| 客户端 | `client.ts` | filehash 算法、接口地址、0xff 无命中协议、主机白名单 |

## 成员合同

宿主调两个操作：`op:'search'` 回候选列表，`op:'fetch'`（入参 `{ id }`）回字幕字节；语言探测、转 VTT、排序都是
宿主的事。filehash 要读视频的四段字节：宿主在 `op:'search'` 里给
`size` 与 `read(offset, length)`（网盘 Range 读），本包自己按射手的协议挑偏移、算 MD5。宿主不知道这个算法。

## filehash（黄金值可验）

4 段各 4096B 的 MD5 hex 用 `;` 连接，偏移 `[4096, floor(size/3*2), floor(size/3), size-8192]`。
响应单字节 `0xff` = 无命中（不报错）；JSON `[{Delay, Files:[{Ext, Link}]}]` 每个 `Link` 一条候选。
