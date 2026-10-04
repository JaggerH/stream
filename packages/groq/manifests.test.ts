import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { manifestSchema } from '../../src/manifest/loader.ts'
import { makeOpenAiSttFn } from '../../src/transcribe/sources.ts'

/**
 * 这个包的转写源是**纯声明**：宿主只提供一个通用的「OpenAI 兼容 STT」实现（builtin mode
 * `transcribe-openai-compat`），端点 / 模型 / 钥匙名全在这份 manifest 里。三样漏任何一样，
 * 宿主那侧是**抛错**不是 decline（见 `src/transcribe/sources.ts`）——但那要等用户真转写一次
 * 才会响，所以在这儿钉死。
 */
const MANIFESTS = fileURLToPath(new URL('./manifests.yaml', import.meta.url))
const list = parse(readFileSync(MANIFESTS, 'utf8')) as unknown[]
const whisper = list.map((m) => manifestSchema.parse(m)).find((m) => m.id === 'groq-whisper')!

describe('packages/groq/manifests.yaml — groq-whisper', () => {
  it('过 manifestSchema，是转写类的 builtin 源', () => {
    expect(whisper).toBeDefined()
    expect(whisper.adapter).toBe('builtin')
    expect(whisper.categories).toContain('transcribe')
    // 整集音频一次成员调用——被全局默认 25s 掐死就永远转不完
    expect(whisper.member_timeout_ms).toBeGreaterThanOrEqual(600_000)
  })

  it('声明了通用 mode 与端点三件套，钥匙名就是它自己那格配置的 ref', () => {
    const fp = whisper.fixed_params as Record<string, unknown>
    expect(fp.mode).toBe('transcribe-openai-compat')
    expect(fp.baseUrl).toMatch(/^https:\/\//)
    expect(typeof fp.model).toBe('string')
    // 用户在配置卡上填的 key 落在 runtime_config `<ref>.apiKey`，宿主按 tokenName 取——两者必须同名，
    // 否则填了 key 这一档仍然永远 decline。
    expect(fp.tokenName).toBe(whisper.runtime_config?.ref)
  })

  it('宿主的通用实现只凭这份声明就能建出后端（不靠任何宿主侧默认值）', async () => {
    let seen: { baseUrl: string; model: string; token: string } | undefined
    const fn = makeOpenAiSttFn({
      tokenProvider: { token: (n) => (n === whisper.runtime_config?.ref ? 'sk' : null) },
      makeBackend: (baseUrl, model, token) => {
        seen = { baseUrl, model, token }
        return { transcribe: vi.fn(async () => ({ text: 'ok', segments: [] })) }
      },
    })
    const fp = whisper.fixed_params as Record<string, unknown>
    await fn({ bytes: new Uint8Array([1]), mime: 'audio/mpeg' }, { ...fp })
    expect(seen).toEqual({ baseUrl: fp.baseUrl, model: fp.model, token: 'sk' })
  })
})
