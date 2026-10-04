import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import {
  aspectFromSize,
  mountImageGenerationRoutes,
  promptWithAspect,
  type ImageGenerationRoutesDeps,
} from './image-generation-routes.ts'

/** recipe 正路：4 张都是无水印原图（image_ori_raw）。 */
const ITEMS = [0, 1, 2, 3].map((i) => ({ guid: `g${i}`, url: `https://cdn/${i}.png`, index: String(i), watermarked: 'false' }))
/** 退路：挖不到原图、退回带水印的预览图。 */
const WATERMARKED = ITEMS.map((it) => ({ ...it, watermarked: 'true' }))

/** 假的执行面：`runAction` 直接 done / 先 running 再 done / 各种失败；`dewatermark` 在字节前面盖个戳。 */
function harness(over: Partial<ImageGenerationRoutesDeps> & { calls?: unknown[] } = {}) {
  const calls: unknown[] = over.calls ?? []
  const app = new Hono()
  mountImageGenerationRoutes(app, {
    models: () => [{ id: '@streamapp/doubao/doubao-image', perRun: 4 }],
    runAction: async (args) => {
      calls.push(args)
      return { status: 'done', sourceId: 'doubao-image', items: ITEMS }
    },
    actionRun: () => null,
    fetchBytes: async (url) => new TextEncoder().encode(`raw:${url}`),
    dewatermark: async (png) => new TextEncoder().encode(`clean:${new TextDecoder().decode(png)}`),
    sleep: async () => {},
    now: () => 1_700_000_000_000,
    ...over,
  })
  const post = (body: unknown) =>
    app.request('/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  return { app, post, calls }
}

const decode = (b64: string) => Buffer.from(b64, 'base64').toString()

describe('aspect from size', () => {
  it('reduces WxH to a ratio, ignores square / garbage', () => {
    expect(aspectFromSize('1536x1024')).toBe('3:2')
    expect(aspectFromSize('1024X1536')).toBe('2:3')
    expect(aspectFromSize('16:9')).toBe('16:9')
    expect(aspectFromSize('1:1')).toBeNull()
    expect(aspectFromSize('1024x1024')).toBeNull()
    expect(aspectFromSize('auto')).toBeNull()
    expect(aspectFromSize(undefined)).toBeNull()
    expect(promptWithAspect(' a wok ', '1792x1024')).toBe('a wok, aspect ratio 7:4')
    expect(promptWithAspect('a wok', '1024x1024')).toBe('a wok')
  })
})

describe('GET /v1/models', () => {
  it('lists the recipes that declare produces:images so a client can "拉取模型"', async () => {
    const { app } = harness()
    const res = await app.request('/v1/models')
    expect(res.status).toBe(200)
    expect((await res.json()).data.map((m: { id: string }) => m.id)).toEqual(['@streamapp/doubao/doubao-image'])
  })
})

describe('POST /v1/images/generations', () => {
  it('runs the recipe confirmed, returns n of the 4 raw images untouched, OpenAI shape', async () => {
    const { post, calls } = harness()
    const res = await post({ model: 'doubao-image', prompt: 'a wok', n: 2, response_format: 'b64_json' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.created).toBe(1_700_000_000)
    expect(body.data).toHaveLength(2)
    expect(body.data.map((d: { b64_json: string }) => decode(d.b64_json))).toEqual([
      'raw:https://cdn/0.png',
      'raw:https://cdn/1.png',
    ])
    expect(body.data[0].revised_prompt).toBe('a wok')
    // confirmed:true 由路由给（程序消费者，同 CLI --yes）；params 只有 schema 里那一个键
    expect(calls).toEqual([{ sourceId: '@streamapp/doubao/doubao-image', params: { prompt: 'a wok' }, confirmed: true }])
  })

  it('model 全名是正名，裸名不歧义时也认，歧义就 400 并列出全名（同 sourceId 判据）', async () => {
    const { post } = harness()
    expect((await post({ model: '@streamapp/doubao/doubao-image', prompt: 'a wok' })).status).toBe(200)
    const two = harness({ models: () => [{ id: '@a/x/gen', perRun: 4 }, { id: '@b/y/gen', perRun: 4 }] })
    const res = await two.post({ model: 'gen', prompt: 'a wok' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toContain('@a/x/gen')
    expect((await two.post({ model: '@b/y/gen', prompt: 'a wok' })).status).toBe(200)
  })

  it('appends the aspect ratio to the prompt and echoes it in revised_prompt', async () => {
    const { post, calls } = harness()
    const body = await (await post({ model: 'doubao-image', prompt: 'a wok', size: '1536x1024' })).json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].revised_prompt).toBe('a wok, aspect ratio 3:2')
    expect((calls[0] as { params: { prompt: string } }).params.prompt).toBe('a wok, aspect ratio 3:2')
  })

  it('polls the run when the action shell answers running', async () => {
    let polls = 0
    const { post } = harness({
      runAction: async () => ({ status: 'running', sourceId: 'doubao-image', runId: 'r1' }),
      actionRun: (runId) => {
        expect(runId).toBe('r1')
        polls++
        return polls < 3
          ? { status: 'running' }
          : { status: 'done', result: { status: 'done', sourceId: 'doubao-image', items: ITEMS } }
      },
    })
    const res = await post({ model: 'doubao-image', prompt: 'a wok' })
    expect(res.status).toBe(200)
    expect(polls).toBe(3)
  })

  it('surfaces recipe failure with its reason (502, OpenAI error shape)', async () => {
    const { post } = harness({
      runAction: async () => ({ status: 'needs-login', sourceId: 'doubao-image', reason: '豆包要重新登录' }),
    })
    const res = await post({ model: 'doubao-image', prompt: 'a wok' })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: { message: '@streamapp/doubao/doubao-image 失败（needs-login）：豆包要重新登录', type: 'server_error' } })
  })

  it('dewatermarks only the items the recipe flagged watermarked (fell back to preview)', async () => {
    const { post } = harness({
      runAction: async () => ({ status: 'done', sourceId: 'doubao-image', items: [WATERMARKED[0], ITEMS[1]] }),
    })
    const body = await (await post({ model: 'doubao-image', prompt: 'a wok', n: 2 })).json()
    expect(body.data.map((d: { b64_json: string }) => decode(d.b64_json))).toEqual([
      'clean:raw:https://cdn/0.png',
      'raw:https://cdn/1.png',
    ])
  })

  it('fails the whole request when dewatermark fails — never returns a watermarked image', async () => {
    const { post } = harness({
      runAction: async () => ({ status: 'done', sourceId: 'doubao-image', items: WATERMARKED }),
      dewatermark: async () => {
        throw new Error('去水印服务 "dewatermark" 解析不到地址')
      },
    })
    const res = await post({ model: 'doubao-image', prompt: 'a wok', n: 2 })
    expect(res.status).toBe(502)
    expect((await res.json()).error.message).toContain('去水印服务')
  })

  it('标了水印、但去水印包没装 → 503 + 安装提示（不是 502、不是带水印的图）', async () => {
    const { post } = harness({
      runAction: async () => ({ status: 'done', sourceId: 'doubao-image', items: WATERMARKED }),
      dewatermark: undefined,
      dewatermarkTarget: () => null,
    })
    const res = await post({ model: 'doubao-image', prompt: 'a wok', n: 2 })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error.type).toBe('server_error')
    expect(body.error.message).toContain('stream add @streamapp/dewatermark')
  })

  it('没标水印的图不碰去水印包——包没装也照常 200', async () => {
    const { post } = harness({ dewatermark: undefined, dewatermarkTarget: () => null })
    const res = await post({ model: 'doubao-image', prompt: 'a wok', n: 1 })
    expect(res.status).toBe(200)
  })

  it('4 concurrent n=1 requests for one prompt share ONE run and get 4 different images', async () => {
    // 无限画布把「张数 4」拆成 4 个并发 n=1 请求；不合批就是 4 张一模一样（活体撞过）。
    let runs = 0
    const { post } = harness({
      runAction: async () => {
        runs++
        await new Promise((r) => setTimeout(r, 20))
        return { status: 'done', sourceId: 'doubao-image', items: ITEMS }
      },
    })
    const bodies = await Promise.all([1, 2, 3, 4].map(async () => (await post({ model: 'doubao-image', prompt: 'a wok', n: 1 })).json()))
    expect(runs).toBe(1)
    expect(bodies.map((b: { data: { b64_json: string }[] }) => decode(b.data[0].b64_json)).sort()).toEqual([0, 1, 2, 3].map((i) => `raw:https://cdn/${i}.png`))
  })

  it('a 5th request for the same prompt starts a new run once the 4 are taken', async () => {
    let runs = 0
    const { post } = harness({
      runAction: async () => {
        runs++
        return { status: 'done', sourceId: 'doubao-image', items: ITEMS.map((it) => ({ ...it, url: `${it.url}?run=${runs}` })) }
      },
    })
    await Promise.all([1, 2, 3, 4].map(() => post({ model: 'doubao-image', prompt: 'a wok', n: 1 })))
    const fifth = await (await post({ model: 'doubao-image', prompt: 'a wok', n: 1 })).json()
    expect(runs).toBe(2)
    expect(decode(fifth.data[0].b64_json)).toBe('raw:https://cdn/0.png?run=2')
  })

  it('/v1/images/edits：multipart 的参考图变成 data URL 递给 recipe（images 参数），结果形状同 generations', async () => {
    const { app, calls } = harness()
    const form = new FormData()
    form.set('model', 'doubao-image')
    form.set('prompt', 'make it ghibli')
    form.set('n', '2')
    form.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), 'ref.jpg')
    const res = await app.request('/v1/images/edits', { method: 'POST', body: form })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toHaveLength(2)
    expect(calls).toEqual([{ sourceId: '@streamapp/doubao/doubao-image', params: { prompt: 'make it ghibli', images: 'data:image/jpeg;base64,AQID' }, confirmed: true }])
  })

  it('/v1/images/edits：没有 image 400；mask 400；参考图不同 = 不同的一轮（不合批）', async () => {
    const { app, calls } = harness()
    const noImage = new FormData()
    noImage.set('model', 'doubao-image')
    noImage.set('prompt', 'x')
    expect((await app.request('/v1/images/edits', { method: 'POST', body: noImage })).status).toBe(400)
    const withMask = new FormData()
    withMask.set('model', 'doubao-image')
    withMask.set('prompt', 'x')
    withMask.append('image', new Blob([new Uint8Array([1])], { type: 'image/png' }), 'a.png')
    withMask.append('mask', new Blob([new Uint8Array([1])], { type: 'image/png' }), 'm.png')
    expect((await app.request('/v1/images/edits', { method: 'POST', body: withMask })).status).toBe(400)
    const mk = (byte: number) => {
      const f = new FormData()
      f.set('model', 'doubao-image')
      f.set('prompt', 'same prompt')
      f.append('image', new Blob([new Uint8Array([byte])], { type: 'image/png' }), 'a.png')
      return f
    }
    await Promise.all([mk(1), mk(2)].map((f) => app.request('/v1/images/edits', { method: 'POST', body: f })))
    expect(calls).toHaveLength(2)
  })

  it('一轮只出 1 张（图生图）时，4 个并发 n=1 请求各开一轮、各拿一张不同的图', async () => {
    let runs = 0
    const { post } = harness({
      runAction: async () => {
        runs++
        return { status: 'done', sourceId: 'doubao-image', items: [{ ...ITEMS[0], url: `https://cdn/round${runs}.png` }] }
      },
    })
    const bodies = await Promise.all([1, 2, 3, 4].map(async () => (await post({ model: 'doubao-image', prompt: 'edit', n: 1 })).json()))
    expect(runs).toBe(4)
    expect(new Set(bodies.map((b) => decode(b.data[0].b64_json))).size).toBe(4)
  })

  it('validates the body: prompt, n range, response_format, unknown keys', async () => {
    const { post, calls } = harness()
    expect((await post({})).status).toBe(400)
    expect((await post({ model: 'nope', prompt: 'x' })).status).toBe(400)
    expect((await post({ model: 'doubao-image' })).status).toBe(400)
    expect((await post({ model: 'doubao-image', prompt: 'x', n: 5 })).status).toBe(400)
    expect((await post({ model: 'doubao-image', prompt: 'x', n: 0 })).status).toBe(400)
    expect((await post({ model: 'doubao-image', prompt: 'x', response_format: 'url' })).status).toBe(400)
    expect((await post({ model: 'doubao-image', prompt: 'x', bogus: 1 })).status).toBe(400)
    expect(calls).toEqual([])
  })
})
