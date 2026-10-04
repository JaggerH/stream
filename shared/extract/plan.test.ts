import { describe, expect, it } from 'vitest'
import { planExtract, type ExtractCapabilities } from './plan.ts'
import type { Content, Media } from './plan.ts'

const ALL: ExtractCapabilities = { stt: true, ocr: true, article: true }
const video = (over: Partial<Extract<Media, { kind: 'video' }>> = {}): Media => ({ kind: 'video', url: 'https://x/v.mp4', ...over })
const audio = (over: Partial<Extract<Media, { kind: 'audio' }>> = {}): Media => ({ kind: 'audio', url: 'https://x/a.mp3', ...over })
const image = (): Media => ({ kind: 'image', url: 'https://x/i.jpg' })
const link = (url: string): Media => ({ kind: 'link', url })
const c = (over: Partial<Content>): Content => ({ archetype: 'text', ...over })

describe('planExtract — archetype 定意图', () => {
  it('video / audio → stt（意图层）', () => {
    expect(planExtract(c({ archetype: 'video', media: [video()] }), ALL)).toMatchObject({ ok: true, branch: 'stt' })
    // 这条守的是一次真实回归：B 站视频是 provider 定位（vid），**没有 url**——上一版判据
    // 写成 `!!m.url`，把转写的主战场判成了没源，「转成文字」按钮在 B 站条目上集体消失。
    expect(planExtract(c({ archetype: 'video', media: [video({ url: undefined, vid: 'BV1x' })] }), ALL)).toMatchObject({ ok: true, branch: 'stt' })
    expect(planExtract(c({ archetype: 'video', media: [video({ url: undefined, embed: '/api/media/douyin/video?u=x' })] }), ALL)).toMatchObject({ ok: true, branch: 'stt' })
  })

  // 镜像后端真身（src/transcribe/media.ts）：带直链的音频后端拉得到字节（命中服务策略的走
  // serveWithPolicy），所以判据放行——播客的转写入口就靠这一条。
  it('带直链的 audio → stt 可取（播客免费集）', () => {
    expect(planExtract(c({ archetype: 'audio', media: [audio()] }), ALL)).toMatchObject({ ok: true, branch: 'stt' })
  })

  // `platform+track_id` = 喂得进播放那条统一漏斗（归档/网盘/官方源/回落四档）。
  // **不分免费付费**：按 resolveOnly 分叉会把归档档与官方源档从免费集手里拿走。
  it('带 platform+track_id 的 audio → stt 可取（付费 resolveOnly 与免费同一条）', () => {
    const paid = planExtract(c({ archetype: 'audio', media: [audio({ url: undefined, resolveOnly: true, platform: 'lizhi', track_id: '1' })] }), ALL)
    expect(paid).toMatchObject({ ok: true, branch: 'stt' })
    const free = planExtract(c({ archetype: 'audio', media: [audio({ url: undefined, platform: 'netease', track_id: '9' })] }), ALL)
    expect(free).toMatchObject({ ok: true, branch: 'stt' })
  })

  it('既没直链也没 platform+track_id 的 audio 仍判没源（封面 only 的降级条目）', () => {
    const p = planExtract(c({ archetype: 'audio', media: [audio({ url: undefined })] }), ALL)
    expect(p).toMatchObject({ ok: false, code: 'no_source', branch: 'stt' })
    const q = planExtract(c({ archetype: 'audio', media: [audio({ url: undefined, resolveOnly: true, platform: 'lizhi' })] }), ALL)
    expect(q).toMatchObject({ ok: false, code: 'no_source', branch: 'stt' })
  })

  it('gallery → ocr', () => {
    expect(planExtract(c({ archetype: 'gallery', media: [image()] }), ALL)).toMatchObject({ ok: true, branch: 'ocr' })
  })

  it('article / link → article，并带出要抓的地址', () => {
    expect(planExtract(c({ archetype: 'article' }), ALL, 'https://p/post')).toMatchObject({ ok: true, branch: 'article', url: 'https://p/post' })
    expect(planExtract(c({ archetype: 'link', media: [link('https://m/1')] }), ALL)).toMatchObject({ ok: true, branch: 'article', url: 'https://m/1' })
  })

  // 白拿的一档：纯文本 post 的正文本来就在 content.text 里，为它跑一趟后端是纯浪费。
  // 它同时让 extract 对**任何** item 都有答案，而不是「只有图和视频能用」。
  it('text → inline，正文直接给，不打任何后端', () => {
    expect(planExtract(c({ archetype: 'text', text: '就这一句' }), ALL)).toEqual({ ok: true, branch: 'inline', text: '就这一句' })
  })

  // 判据一律不看后端配没配——`inline` 连后端都不打，全关也照样成立。
  it('inline 不受后端可用性影响', () => {
    expect(planExtract(c({ archetype: 'text', text: 'x' }), { stt: false, ocr: false, article: false })).toMatchObject({ ok: true, branch: 'inline' })
  })
})

describe('planExtract — forward 看被转发体', () => {
  it('转发一条视频 → 按视频判', () => {
    const p = planExtract(c({ archetype: 'forward', quoted: { archetype: 'video', media: [video()] } }), ALL)
    expect(p).toMatchObject({ ok: true, branch: 'stt' })
  })

  it('被转发体没标 archetype → 退回外层自己的正文（而不是猜）', () => {
    const p = planExtract(c({ archetype: 'forward', text: '转发理由', quoted: { text: '原文' } }), ALL)
    expect(p).toMatchObject({ ok: true, branch: 'inline' })
  })

  // 转发链深不过一层：`Quoted` 没有 `quoted` 字段（src/content/types.ts），所以「转发的转发」
  // 在类型上不存在。这里守的是那一跳之后**不再看外层**——外层的文字是转发理由，不是正文。
  it('跟过去之后按被转发体判，不受外层文字干扰', () => {
    const p = planExtract(c({ archetype: 'forward', text: '这个必须看', quoted: { archetype: 'gallery', media: [image()] } }), ALL)
    expect(p).toMatchObject({ ok: true, branch: 'ocr' })
  })
})

describe('planExtract — 意图有，但不可行：必须失败，绝不换分支', () => {
  // 这是整个判定里最要紧的一条。一条视频 post 把封面图 OCR 出来当正文，比明确失败**更坏**：
  // 它会安静产出一份看着成功、实则完全不对的结果，而下游的总结会认真地总结那张封面。
  it('视频 post 有封面图，但转写不可用 → 报 stt 不可用，不退到 ocr', () => {
    const p = planExtract(c({ archetype: 'video', media: [video(), image()] }), { stt: false, ocr: true, article: true })
    expect(p.ok).toBe(false)
    if (!p.ok) {
      expect(p.code).toBe('branch_unavailable')
      expect(p.branch).toBe('stt')
      expect(p.message).not.toContain('ocr')
    }
  })

  it('视频只有引用没有可取的流（resolveOnly 且无 url）→ 报不可取，不退到别的分支', () => {
    const p = planExtract(c({ archetype: 'video', media: [video({ url: undefined, resolveOnly: true }), image()] }), ALL)
    expect(p.ok).toBe(false)
    if (!p.ok) expect(p.code).toBe('no_source')
  })

  it('gallery 但一张图都没有 → 不可取', () => {
    const p = planExtract(c({ archetype: 'gallery', media: [] }), ALL)
    expect(p).toMatchObject({ ok: false, code: 'no_source' })
  })

  it('article 但拿不到地址 → 不可取', () => {
    expect(planExtract(c({ archetype: 'article' }), ALL)).toMatchObject({ ok: false, code: 'no_source' })
  })

  it('text 但正文是空的、也没有链接 → 不可取（不返回一个空字符串装成功）', () => {
    expect(planExtract(c({ archetype: 'text', text: '   ' }), ALL)).toMatchObject({ ok: false, code: 'no_source' })
  })

  // 网页搜索源的命中就是这形状:只有标题+链接,没有正文。不退去抓网页,这类条目 extract
  // 恒 no_source(2026-08-23 活体:三条百家号横评全倒在这里)。
  it('text 正文空但有 item.url → 退到 article 抓网页', () => {
    expect(planExtract(c({ archetype: 'text' }), ALL, 'https://baijiahao.baidu.com/s?id=1')).toEqual({
      ok: true, branch: 'article', url: 'https://baijiahao.baidu.com/s?id=1',
    })
  })

  it('text 正文空有链接、但 article 未配 → 报 article 未配置(不谎报没源)', () => {
    expect(planExtract(c({ archetype: 'text' }), { ...ALL, article: false }, 'https://x/p')).toMatchObject({
      ok: false, code: 'branch_unavailable', branch: 'article',
    })
  })

  it('text 有正文时仍走 inline,链接不改道', () => {
    expect(planExtract(c({ archetype: 'text', text: '正文在此' }), ALL, 'https://x/p')).toEqual({
      ok: true, branch: 'inline', text: '正文在此',
    })
  })

  it('各分支的后端没配，各报各的分支名', () => {
    expect(planExtract(c({ archetype: 'gallery', media: [image()] }), { ...ALL, ocr: false })).toMatchObject({ ok: false, code: 'branch_unavailable', branch: 'ocr' })
    expect(planExtract(c({ archetype: 'link', media: [link('https://m/1')] }), { ...ALL, article: false })).toMatchObject({ ok: false, code: 'branch_unavailable', branch: 'article' })
  })

  // 可行性先于可用性：源都没有的时候，报"后端没配"会把人支到设置页去白跑一趟。
  it('既没有源、后端也没配 → 报没有源（别把人支去配置）', () => {
    expect(planExtract(c({ archetype: 'gallery', media: [] }), { ...ALL, ocr: false })).toMatchObject({ ok: false, code: 'no_source' })
  })
})

describe('planExtract — 媒体由句柄解析（网盘绑定的分集）', () => {
  // `tmdb:…:S01E02` 这类句柄压根不是 item，没有 media 描述符——字节由 transcribe 的 resolver
  // 按句柄取。不给它放行的话，转写最典型的那类输入会被判成「没有可转写的东西」。
  it('没有 media 也照样成立', () => {
    expect(planExtract(c({ archetype: 'video', media: [], resolvedByHandle: true }), ALL)).toMatchObject({ ok: true, branch: 'stt' })
  })

  it('但后端没配还是要报不可用——放行的是「有没有源」，不是「配没配」', () => {
    expect(planExtract(c({ archetype: 'video', resolvedByHandle: true }), { ...ALL, stt: false }))
      .toMatchObject({ ok: false, code: 'branch_unavailable' })
  })
})

describe('planExtract — PDF 走 ocr', () => {
  it('gallery 之外，带 .pdf 链接的也归 ocr（parse 行本来就吃 PDF）', () => {
    const p = planExtract(c({ archetype: 'link', media: [link('https://x/paper.pdf')] }), ALL)
    expect(p).toMatchObject({ ok: true, branch: 'ocr' })
  })
})
