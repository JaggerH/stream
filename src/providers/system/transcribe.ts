import type { SystemIdentity } from './types.ts'

/**
 * 语音转文字 —— **唯一一条条件建行的系统身份**：`ensureSystemRows` 跳过它，改由
 * `ensureTranscribeRow`（`src/providers/seed.ts`）按「哪些 token 在」决定建不建、建成什么样。
 *
 * **`defaultMembers` 是完整的成本阶梯，不带 token 门控，所以整份落不得库**：没配 key 的那一档
 * 进了梯子就是一条永远 decline 的腿，而页面上看起来是「配好了」。`ensureTranscribeRow` 按
 * `params.tokenName` 筛，只把有 key 的档写进成员。
 *
 * 门控今天仍是启动期一次性快照（token 热配置后要重启）。cordis 的条件挂载（`inject`：token
 * 缺席 = fiber PENDING = 不进 `active()`）把它治掉，见
 * `docs/superpowers/specs/2026-08-16-cordis-kernel-adoption-design.md` §3.2。
 *
 * 梯子顺序（拍板 2026-07-26，实测依据）：**Groq 排第一**——账号在 Groq 的 Free 档（$0），
 * whisper 的配额就是它的速率上限（每小时 7,200 秒、每天 28,800 秒音频），超了返回 429 而不是
 * 账单；定价页那个 $0.111/小时 是 Developer 档的价，不适用。加上 217× 实时的速度，它是这条
 * 梯子上最便宜也最快的一档。CF 退居第二档兜它的日配额。
 *
 * `fallback: true` = 现状的 `serves: ['*']`：transcribe category 只有这一行，兜底与具名等价，
 * 取现状原样（口径变更不混进等价重构）。
 */
export const transcribe: SystemIdentity = {
  id: 'transcribe',
  category: 'transcribe',
  serveKeys: [],
  fallback: true,
  strategy: 'sequential',
  contract: null,
  defaultLabel: '语音转文字',
  defaultDescription: '视频/音频转写（云端各档按成本顺序逐个试，没配钥匙的档自动让给下一档）',
  defaultMembers: [
    { source: '@streamapp/groq/groq-whisper', params: { tokenName: 'groq' } },
    { source: '@streamapp/cloudflare/cf-whisper', params: { tokenName: 'cloudflare' } },
    { source: '@streamapp/builtin/openai-whisper', params: { tokenName: 'openai' } },
  ],
}
