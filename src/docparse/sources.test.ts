import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeOcrVlmFn, makeOcrMineruFn, type OcrInput } from './sources.ts'

const input: OcrInput = { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' }

function mockFetch(json: unknown) {
  const fn = vi.fn((..._args: unknown[]) =>
    Promise.resolve({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) })
  )
  globalThis.fetch = fn as unknown as typeof fetch
  return fn
}

// 视觉模型做 OCR 和文本总结在传输层是同一件事：同一个 /chat/completions、同一把钥匙，
// 只是消息正文里多一个 image 分片。所以这里不该出现第二套协议。
describe('makeOcrVlmFn', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('把字节包成 data: URI 的 image 分片，打同一个 /chat/completions', async () => {
    const fn = mockFetch({ choices: [{ message: { content: '# 标题\n正文' } }] })
    const out = await makeOcrVlmFn({ token: (n) => (n === 'ocr:zhipu' ? 'sk-x' : null) })(
      input,
      { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v-flash', tokenName: 'ocr:zhipu' },
    )
    expect(out).toEqual([{ markdown: '# 标题\n正文' }])
    expect(fn.mock.calls[0][0]).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions')

    const body = JSON.parse((fn.mock.calls[0][1] as { body: string }).body) as {
      model: string
      messages: Array<{ role: string; content: unknown }>
    }
    expect(body.model).toBe('glm-4v-flash')
    const parts = body.messages.at(-1)!.content as Array<Record<string, unknown>>
    const img = parts.find((p) => p.type === 'image_url') as { image_url: { url: string } }
    // data: URI 要带上真实 mime —— 写错 mime 有的平台直接 400，而报错和"图看不懂"长得一样
    expect(img.image_url.url.startsWith('data:image/png;base64,')).toBe(true)
    expect(parts.some((p) => p.type === 'text')).toBe(true) // 得给它一句指令，不能只丢张图
  })

  it('缺 key / 缺端点 / 缺模型 → decline（[]），且不发请求', async () => {
    const fn = mockFetch({})
    const noKey = await makeOcrVlmFn({ token: () => null })(input, { baseUrl: 'https://x/v1', model: 'm', tokenName: 'ocr:none' })
    const noUrl = await makeOcrVlmFn({ token: () => 'sk' })(input, { model: 'm', tokenName: 'ocr:a' })
    const noModel = await makeOcrVlmFn({ token: () => 'sk' })(input, { baseUrl: 'https://x/v1', tokenName: 'ocr:a' })
    expect([noKey, noUrl, noModel]).toEqual([[], [], []])
    expect(fn).not.toHaveBeenCalled()
  })

  // 「试过但没成」必须和「弃权」分开：`[]` 在 executor 的 misses 里是**不可见**的，梯子会静静
  // 落到兜底，兜底再失败就只剩一句"没有成员产出结果"，没人说得出为什么（活体栽过）。抛错则被
  // 记成 miss（member + reason）**并且照样继续回落**——不挡兜底，还留下理由。
  it('模型返回空正文 → 抛错（带 model/mime/字节数），不是静默 decline', async () => {
    mockFetch({ choices: [{ message: { content: '' } }] })
    const call = makeOcrVlmFn({ token: () => 'sk' })(input, { baseUrl: 'https://x/v1', model: 'glm-4v-flash', tokenName: 'ocr:a' })
    await expect(call).rejects.toThrow(/空正文/)
    // 空正文最常见的原因是图片格式/体积——那两个数就在手边，别让排查的人自己去猜
    await makeOcrVlmFn({ token: () => 'sk' })(input, { baseUrl: 'https://x/v1', model: 'glm-4v-flash', tokenName: 'ocr:a' })
      .catch((e: Error) => {
        expect(e.message).toContain('image/png')
        expect(e.message).toContain('glm-4v-flash')
        expect(e.message).toContain('3 bytes')
      })
  })
})

describe('makeOcrMineruFn', () => {
  it('透传本地后端的 markdown', async () => {
    const out = await makeOcrMineruFn({ parse: async () => ({ markdown: 'from mineru' }) })(input, {})
    expect(out).toEqual([{ markdown: 'from mineru' }])
  })

  it('后端没配（client 抛）→ 让错误冒上去，不伪装成空结果', async () => {
    const fn = makeOcrMineruFn({ parse: async () => { throw new Error('mineru not configured') } })
    await expect(fn(input, {})).rejects.toThrow('mineru not configured')
  })
})
