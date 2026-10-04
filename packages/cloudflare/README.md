# @streamapp/cloudflare

Cloudflare Workers AI 这一家在 Stream 里的知识。宿主不认识 Cloudflare，只认识「`transcribe` 梯子上有个转写成员」。

## 管什么

| 东西 | 在哪 | 做什么 |
|---|---|---|
| 源 `cf-whisper` | `manifests.yaml` | 音频字节 → 转写（whisper-large-v3-turbo，多语含中文，无说话人分离） |
| adapter `cloudflare` | `activate.ts` → `adapter.ts` | 执行上面那个源 |
| API 客户端 | `client.ts` | `POST /client/v4/accounts/<账号>/ai/run/<模型>`，音频 base64 进 JSON |

## 成员合同

- 输入：转写调用点给的 `{ bytes, mime, opts? }`，执行器按字段摊进 `params`。
- decline（`[]`，让给梯子下一档）：要说话人分离、>20MB、钥匙不全（`apiKey` 或 `accountId` 缺一）。
- 请求失败一律**抛**，不吞成 decline。
- 产出 `[{ text, lang, segments }]`。

## 钥匙

宿主派发，包不索取。manifest 声明 `runtime_config.ref: cloudflare`（`apiKey` + `accountId`），宿主在调用前解析好放进
`context.runtimeConfig`：配置页填的值优先，空着回落部署环境变量（`CLOUDFLARE_WORKERS_AI_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID`，回落由宿主做）。包自己不读 env。

## 它排在哪一档

`transcribe` 梯子的第二档（Groq 之后、OpenAI 之前）。顺序是宿主的成本判断，不由本包决定。
