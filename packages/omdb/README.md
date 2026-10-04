# @streamapp/omdb

OMDb 这一家在 Stream 里的知识。宿主不认识 OMDb，只认识「影视详情的 `video-metadata` / `video-images` 两行上有成员」。

## 管什么

| 东西 | 在哪 | 做什么 |
|---|---|---|
| 源 `omdb-metadata` | `manifests.yaml` | 作品身份 → 标题、简介、类型、演职员、评分（含 IMDb 评分）、IMDb id |
| 源 `omdb-images` | `manifests.yaml` | 作品身份 → 海报候选 |
| adapter `omdb` | `activate.ts` → `adapter.ts` | 执行上面两个源（按 `fixed_params.mode` 分） |
| API 客户端 | `client.ts` | `GET https://www.omdbapi.com/?apikey=…&i=<imdb>`（没有 imdb id 时按标题 / 年份 / 类型查） |

## 成员合同

- 输入：影视详情调用点给的作品身份 `{ title, year?, kind?, externalIds }`，执行器按字段摊进 `params`。
- decline（`[]`）：没钥匙、没标题、OMDb 查不到；**没有 imdb id 时标题年份对不上也 decline**——标题查询只是候选，
  不许 OMDb 的模糊匹配把一部作品换成另一部。
- HTTP 失败一律**抛**。

## 钥匙

宿主派发，包不索取。manifest 声明 `runtime_config.ref: omdb`（`apiKey`），宿主在调用前解析好放进
`context.runtimeConfig`：配置页填的值；老版本「影视源设置」里填的 OMDb key 由宿主投影成同一个 ref（回落在宿主）。

## 它排在哪

`video-metadata` / `video-images` 两行的第二个成员（TMDb 之后，补空）。顺序是宿主的判断，不由本包决定。
