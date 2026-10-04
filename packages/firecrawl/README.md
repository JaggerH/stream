# @streamapp/firecrawl

Firecrawl 这一家在 Stream 里的全部知识。宿主不认识 Firecrawl，只认识「`article-extract` 梯子上有个抓正文的成员」。

## 管什么

| 东西 | 在哪 | 做什么 |
|---|---|---|
| 源 `article-firecrawl` | `manifests.yaml` | 网页 URL → 正文 markdown（云端跑 JS），`output: object` |
| adapter `firecrawl` | `activate.ts` → `adapter.ts` | 执行上面那个源：调 `/v2/scrape`，归形成 `{ text }` |
| API 客户端 | `client.ts` | 失败分三类：`rate_limited` / `unavailable` / `transport`，下一步各不相同 |
| 读 / 建 key | `firecrawl-read-key.recipe.json`、`firecrawl-create-key.recipe.json` | 在用户自己的 Chrome 里拿 key，明文落进 runtime_config `firecrawl.apiKey` |

## 成员合同

- 输入：`params.url`。宿主的梯子行写的是 `{ url: '$input' }`，执行器把洞填进 params。
- 不是 http(s) URL → decline（`[]`），不打网络。
- 抓取失败一律**抛**，不吞成 decline。decline 的意思是「让位」，不是「试了失败」；混用会把限流记成弃权。
- 产出一个 `{ text, title, finalUrl, creditsUsed }`，`text` 即 markdown。manifest 必须有 `output: object`，漏了梯子会把整个数组当赢家交出去。

## 钥匙

宿主派发，包不索取。manifest 声明 `runtime_config.ref: firecrawl`，宿主在调用前把那一格解析好放进 `context.runtimeConfig`，adapter 只读 `apiKey`。

key 是可选的：keyless 免费档按出口 IP 记账、与同节点的他人共享，额度可能被先吃掉且只表现为 429。没 key 照样调，不 decline。

## 它排在哪一档

`article-extract` 梯子的第二档，排在裸 HTTP 的 Defuddle 后面。顺序是宿主的成本判断：不出境、免费的在前，把 URL 发给第三方、烧额度的在后。写在 `src/providers/system/article-extract.ts`。
