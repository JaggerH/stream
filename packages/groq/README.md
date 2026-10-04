# @streamapp/groq

Groq 这一家在 Stream 里的全部知识。宿主不认识 Groq，只认识「一个 OpenAI 兼容的转写端点」。

## 管什么

| 东西 | 在哪 | 做什么 |
|---|---|---|
| 转写源 `groq-whisper` | `manifests.yaml` | 转写梯子的一档：音频 → 文字，whisper-large-v3，BYOK |
| 自助建 key | `groq-create-key.recipe.json` | 在用户自己的 Chrome 里登 console.groq.com 建一把 key，明文落进 runtime_config `groq.apiKey` |

## 转写源是纯声明

`groq-whisper` 没有代码。它声明 `adapter: builtin` + `fixed_params.mode: transcribe-openai-compat`，
宿主那份通用实现（`src/transcribe/sources.ts` 的 `makeOpenAiSttFn`）从 `fixed_params` 读三件事：

- `baseUrl`：`https://api.groq.com/openai/v1`
- `model`：`whisper-large-v3`
- `tokenName`：`groq`，**必须等于** `runtime_config.ref`。用户在配置卡上填的 key 落在 `groq.apiKey`，宿主按 `tokenName` 取；两者不同名，这一档就永远 decline。

三样漏任何一样，宿主那侧抛错而不是 decline。守卫在 `manifests.test.ts`。

切块（>24MB）、调试总线上的分块计划、「没 key / 要说话人分离 → decline 让给下一档」这些规则都住在宿主，所有 OpenAI 兼容的转写源共用一份。

## 钥匙从哪来

宿主派发，包不索取。取值两层，存储层优先：

1. runtime_config `groq.apiKey`：配置卡手填，或 `groq-create-key` 自己建完写进来。
2. 环境变量 `GROQ_API_KEY`。这一层的「逻辑名 → 环境变量名」映射今天仍写在宿主 `src/kernel/plugins/credentials.ts` 的 TokenProvider 表里，因为包还没有申报环境变量名的声明位。

## 它排在转写梯子的哪一档

第一档。梯子的顺序是宿主的成本判断，写在 `src/providers/system/transcribe.ts`，理由（Free 档配额即速率上限、217× 实时）也在那儿。
