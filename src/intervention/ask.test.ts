import { describe, it, expect } from 'vitest'
import { buildMessages, parseAnswer, askOnce, ALLOWED_FEATURE_KINDS, featureKindAllowed } from './ask.ts'
import type { LlmForTask } from '../llm/task.ts'

const known = [{ id: 'xhs/home', features: [{ kind: 'url' as const, pattern: 'https://www.xiaohongshu.com/explore*' }] }]
/** 浏览器侧的解析上下文；facility 与下面用到的 stateId 前缀对齐，免得触发改写。 */
const web = { side: 'browser' as const, facility: 'xhs' }
const desk = { side: 'desktop' as const, facility: 'qq' }

describe('buildMessages', () => {
  it('有截图时用 image_url 分片；元素表与已知状态进正文；system 里有 Feature 语法', () => {
    const m = buildMessages({
      kind: 'state', sourceId: 'xhs-search', side: 'browser', facility: 'xhs', known, reason: 'r',
      scene: { side: 'browser', url: 'https://x/s', elements: [{ n: 1, tag: 'button', name: '搜索', rect: { x: 0, y: 0, w: 1, h: 1 } }], shot: { mime: 'image/jpeg', base64: 'QUJD' } },
    })
    expect(m[0]!.role).toBe('system')
    expect(String(m[0]!.content)).toMatch(/"kind":\s*"dom"/)
    const user = m[1]!.content as Array<{ type: string; image_url?: { url: string }; text?: string }>
    expect(user.some((p) => p.type === 'image_url' && p.image_url!.url.startsWith('data:image/jpeg;base64,QUJD'))).toBe(true)
    const text = user.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
    expect(text).toContain('xhs/home')
    expect(text).toContain('搜索')
  })
  it('没截图时正文是纯文本', () => {
    const m = buildMessages({ kind: 'state', sourceId: 'a', side: 'browser', facility: 'a', known, reason: 'r', scene: { side: 'browser', elements: [] } })
    expect(typeof m[1]!.content).toBe('string')
  })

  /**
   * 语法表按路线裁：浏览器侧把 `text` / `a11y` 摆出来，模型就会挑一条这一侧求值不了的
   * （活体 2026-09-11 它挑了 `text`），而那条一旦进图就是整个 facility 的 identify 全哑。
   */
  it('浏览器侧的 system 只列 url / dom，不提 text / a11y / image', () => {
    const sys = String(buildMessages({ kind: 'state', sourceId: 'a', side: 'browser', facility: 'xhs', known, reason: 'r' })[0]!.content)
    expect(sys).toContain('"kind":"url"')
    expect(sys).toContain('"kind":"dom"')
    expect(sys).not.toContain('"kind":"text"')
    expect(sys).not.toContain('"kind":"a11y"')
    expect(sys).not.toContain('"kind":"image"')
    expect(sys).toContain('浏览器')
  })
  it('桌面侧的 system 只列 a11y / text / image，不提 url / dom', () => {
    const sys = String(buildMessages({ kind: 'state', sourceId: 'a', side: 'desktop', facility: 'qq', known, reason: 'r' })[0]!.content)
    expect(sys).toContain('"kind":"a11y"')
    expect(sys).toContain('"kind":"text"')
    expect(sys).not.toContain('"kind":"url"')
    expect(sys).not.toContain('"kind":"dom"')
  })

  /** stateId 的前缀点名给到字面量：活体上模型照着 `<包>` 这个占位填了 sourceId，入库当场 400。 */
  it('state 的问法里把 facility 前缀写成字面量', () => {
    const m = buildMessages({ kind: 'state', sourceId: 'xhs-search', side: 'browser', facility: 'xhs', known, reason: 'r' })
    expect(String(m[1]!.content)).toContain('{"stateId":"xhs/<状态名>"')
  })
})

describe('ALLOWED_FEATURE_KINDS', () => {
  it('两侧各认各的，交集为空', () => {
    expect([...ALLOWED_FEATURE_KINDS.browser]).toEqual(['url', 'dom'])
    expect([...ALLOWED_FEATURE_KINDS.desktop]).toEqual(['a11y', 'text', 'image'])
    expect(featureKindAllowed('browser', 'dom')).toBe(true)
    expect(featureKindAllowed('browser', 'text')).toBe(false)
    expect(featureKindAllowed('desktop', 'dom')).toBe(false)
  })
})

describe('parseAnswer', () => {
  it('state：合法 JSON → features 是我们的词汇', () => {
    const r = parseAnswer('state', '```json\n{"stateId":"xhs/results","features":[{"kind":"dom","selector":".note-item"}],"rationale":"有笔记卡"}\n```', web)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.answer).toMatchObject({ kind: 'state', stateId: 'xhs/results' })
  })
  it('非 JSON / 不认识的 kind / 空 features → 拒，说明为什么', () => {
    expect(parseAnswer('state', '我觉得这是首页', web).ok).toBe(false)
    expect(parseAnswer('state', '{"stateId":"a","features":[{"kind":"css","selector":"x"}],"rationale":""}', web).ok).toBe(false)
    expect(parseAnswer('state', '{"stateId":"a","features":[],"rationale":"x"}', web).ok).toBe(false)
  })
  // 数组也是 object：不排掉的话 `["按钮"]` 会被收成一条合法 a11y 特征，而下游按
  // `{role,name}` 读它只读到 undefined——一条永远匹配不上的特征，且一路不报错。
  it('a11y 的 query 是数组 → 拒；是对象 → 收（桌面侧）', () => {
    expect(parseAnswer('state', '{"stateId":"qq/b","features":[{"kind":"a11y","query":["按钮"]}],"rationale":"x"}', desk).ok).toBe(false)
    expect(parseAnswer('state', '{"stateId":"qq/b","features":[{"kind":"a11y","query":{"name":"按钮"}}],"rationale":"x"}', desk).ok).toBe(true)
  })

  /**
   * 活体 2026-09-11：xhs-search 上模型提了一条 `text` 特征。它词汇合法，但浏览器侧的
   * `DomPerception` 求值时直接抛——进了图就是那个 facility 此后每趟 identify 都哑。
   */
  it('浏览器侧的 text / a11y / image 特征 → 拒，且说清是路线判不了', () => {
    const r = parseAnswer('state', '{"stateId":"xhs/results","features":[{"kind":"text","text":"搜索结果"}],"rationale":"x"}', web)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.why).toBe('浏览器这条路线判不了 text 特征（只认 url / dom）')
    expect(parseAnswer('state', '{"stateId":"xhs/r","features":[{"kind":"image","png":"QQ=="}],"rationale":"x"}', web).ok).toBe(false)
  })
  it('桌面侧的 dom / url 特征 → 拒', () => {
    const r = parseAnswer('state', '{"stateId":"qq/chat","features":[{"kind":"dom","selector":".x"}],"rationale":"x"}', desk)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.why).toBe('桌面这条路线判不了 dom 特征（只认 a11y / text / image）')
    expect(parseAnswer('state', '{"stateId":"qq/c","features":[{"kind":"url","pattern":"http://x/*"}],"rationale":"x"}', desk).ok).toBe(false)
  })
  it('浏览器侧的 url / dom 都收', () => {
    expect(parseAnswer('state', '{"stateId":"xhs/a","features":[{"kind":"url","pattern":"https://x/*"}],"rationale":"x"}', web).ok).toBe(true)
    expect(parseAnswer('state', '{"stateId":"xhs/a","features":[{"kind":"dom","selector":".x"}],"rationale":"x"}', web).ok).toBe(true)
  })

  /**
   * 活体 2026-09-11：模型把 stateId 写成 `xhs-search/search`（sourceId 前缀），照单收下会被
   * 入库那一关 400（`bad-state-id`）。改名是约定问题，不该赔掉一次真正的判断——但必须留痕。
   */
  it('stateId 前缀不是 facility → 改写成 facility/<末段>，并在 notes 里说清', () => {
    const r = parseAnswer('state', '{"stateId":"xhs-search/search","features":[{"kind":"dom","selector":".x"}],"rationale":"x"}', web)
    expect(r.ok).toBe(true)
    if (r.ok && r.answer.kind === 'state') {
      expect(r.answer.stateId).toBe('xhs/search')
      expect(r.answer.notes).toEqual(['stateId 前缀按 facility 改写：xhs-search/search → xhs/search'])
    }
  })
  it('前缀本来就对 → 原样收下，没有 notes', () => {
    const r = parseAnswer('state', '{"stateId":"xhs/results","features":[{"kind":"dom","selector":".x"}],"rationale":"x"}', web)
    expect(r.ok && r.answer.kind === 'state' && r.answer.notes).toBeUndefined()
  })

  it('顶层是数组 → 拒（答案约定是对象，数组说明模型答的是别的问题）', () => {
    expect(parseAnswer('state', '[{"stateId":"a","features":[],"rationale":"x"}]', web).ok).toBe(false)
  })
  it('content 是 null → 拒（模型没有返回文本）', () => {
    expect(parseAnswer('state', null, web).ok).toBe(false)
  })
  it('模型说修不了 → unrepairable 也是合法答案', () => {
    const r = parseAnswer('state', '{"unrepairable":true,"rationale":"页面要登录"}', web)
    expect(r.ok && r.answer.kind === 'unrepairable').toBe(true)
  })
  it('transition：目标 + 动作', () => {
    const r = parseAnswer('transition', '{"target":{"selector":"button.search"},"action":"click","rationale":"点搜索"}', web)
    expect(r.ok && r.answer.kind === 'transition').toBe(true)
  })

  /** 探索建图前的拉黑闸：一屏一次圈出「点了收不回」的编号。 */
  describe('irreversible：一屏一次的拉黑闸', () => {
    it('问题里带编号元素表；答案只认 refs 数组', () => {
      const msgs = buildMessages({
        kind: 'irreversible', sourceId: 's', side: 'browser', facility: 'xhs', known: [], reason: '探索前筛一屏',
        scene: {
          side: 'browser',
          elements: [
            { n: 1, name: '发布', rect: { x: 0, y: 0, w: 1, h: 1 } },
            { n: 2, name: '搜索', rect: { x: 0, y: 0, w: 1, h: 1 } },
          ],
        },
      })
      const user = msgs[1]!.content
      const text = typeof user === 'string' ? user : user.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('')
      expect(text).toMatch(/收不回/)
      expect(text).toMatch(/#1.*发布/)
      const r1 = parseAnswer('irreversible', '```json\n{"refs":[1],"rationale":"发布会发出去"}\n```', web)
      expect(r1.ok).toBe(true)
      if (r1.ok) expect(r1.answer).toMatchObject({ kind: 'irreversible', refs: [1] })
      const r2 = parseAnswer('irreversible', '{"refs":[]}', web)
      expect(r2.ok).toBe(true)
      if (r2.ok) expect(r2.answer).toMatchObject({ kind: 'irreversible', refs: [] })
      expect(parseAnswer('irreversible', '{"refs":["1"]}', web).ok).toBe(false)
    })
  })
})

describe('askOnce', () => {
  const base = { kind: 'state' as const, sourceId: 'a', side: 'browser' as const, facility: 'a', known, reason: 'r' }
  it('走 intervention.ask 调用点；usage 从 raw 读；缺席 reported:false', async () => {
    const seen: string[] = []
    const llm: LlmForTask = async (id) => { seen.push(id); return { content: '{"stateId":"a/x","features":[{"kind":"dom","selector":".x"}],"rationale":"r"}', raw: {} } }
    const r = await askOnce(llm, base)
    expect(seen).toEqual(['intervention.ask'])
    expect(r.answer.ok).toBe(true)
    expect(r.usage).toEqual({ promptTokens: 0, completionTokens: 0, reported: false })
    const llm2: LlmForTask = async () => ({ content: '{"unrepairable":true,"rationale":"x"}', raw: { usage: { prompt_tokens: 12, completion_tokens: 3 } } })
    const r2 = await askOnce(llm2, base)
    expect(r2.usage).toEqual({ promptTokens: 12, completionTokens: 3, reported: true })
  })
  it('梯子没人答（null）→ 原样抛 LadderError 给 Broker 分类', async () => {
    const llm: LlmForTask = async () => null
    await expect(askOnce(llm, base)).rejects.toThrow(/LLM/)
  })
})
