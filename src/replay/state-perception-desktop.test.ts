import { describe, expect, it } from 'vitest'
import { DesktopPerception, type DesktopProbe } from './state-perception-desktop.ts'
import type { ImageHit, TextRead } from './desktop-driver.ts'
import type { StateDef } from './state-graph.ts'

const WINDOW = { x: 0, y: 0, w: 1023, h: 653 }

/** 把几段文字摆成一屏。给了 rect 就用给的，没给就一段一行往下排。 */
const screenOf = (segs: Array<string | { text: string; x: number; y: number; w: number; h: number }>): TextRead => ({
  texts: segs.map((s, i) =>
    typeof s === 'string'
      ? { text: s, rect: { x: 10, y: 10 + i * 30, w: 200, h: 20 } }
      : { text: s.text, rect: { x: s.x, y: s.y, w: s.w, h: s.h } },
  ),
  window: WINDOW,
  scale: 1,
})

/** `reads` 数的是读屏次数——「一次 identify 只读一次屏」「不带 where 就一次不读」都靠它。 */
const probe = (opts: {
  controls?: string[]
  screen?: TextRead
  image?: ImageHit | null
}): DesktopProbe & { reads: number } => {
  const p: DesktopProbe & { reads: number } = {
    reads: 0,
    async findCount(q) {
      return (opts.controls ?? []).includes(q.name ?? q.nameContains ?? '') ? 1 : 0
    },
    async readText() {
      p.reads += 1
      return opts.screen ?? screenOf([])
    },
    async findImage() {
      return opts.image ?? null
    },
  }
  return p
}

describe('DesktopPerception', () => {
  const states: StateDef[] = [
    { id: 'chat', features: [{ kind: 'a11y', query: { role: 'Edit', name: '消息' } }] },
    { id: 'login', features: [{ kind: 'text', text: '扫码登录' }] },
  ]

  it('a11y 特征命中就认出来', async () => {
    const p = new DesktopPerception(probe({ controls: ['消息'] }))
    expect(await p.identify(states)).toMatchObject({ states: ['chat'] })
  })

  it('OCR 文字特征命中就认出来（判据是包含，不是整段相等）', async () => {
    const p = new DesktopPerception(probe({ screen: screenOf(['请用手机扫码登录后继续']) }))
    expect(await p.identify(states)).toMatchObject({ states: ['login'] })
  })

  it('分段被 OCR 切开时靠拼行救回来——切开的那些帧不该表现成"这东西没出现"', async () => {
    const split = screenOf([
      { text: '进入全网搜索', x: 100, y: 200, w: 90, h: 20 },
      { text: '查找用户、群聊等', x: 195, y: 200, w: 110, h: 20 },
    ])
    const s: StateDef[] = [{ id: 'search', features: [{ kind: 'text', text: '进入全网搜索查找用户' }] }]
    expect(await new DesktopPerception(probe({ screen: split })).identify(s)).toMatchObject({ states: ['search'] })
  })

  it('absent 的文字特征：那串字不在才为真', async () => {
    const s: StateDef[] = [{ id: 'list', features: [{ kind: 'text', text: '全网搜', absent: true }] }]
    expect(await new DesktopPerception(probe({ screen: screenOf(['蟠龙中2']) })).identify(s)).toMatchObject({
      states: ['list'],
    })
    expect(
      await new DesktopPerception(probe({ screen: screenOf(['进入全网搜索']) })).identify(s),
    ).toMatchObject({ states: null })
  })

  it('absent 的 a11y 特征：控件不在才为真', async () => {
    const s: StateDef[] = [
      { id: 'sent', features: [{ kind: 'a11y', query: { role: 'Button', name: '发送' }, absent: true }] },
    ]
    expect(await new DesktopPerception(probe({ controls: [] })).identify(s)).toMatchObject({ states: ['sent'] })
    expect(await new DesktopPerception(probe({ controls: ['发送'] })).identify(s)).toMatchObject({
      states: null,
    })
  })

  it('同一串字在屏上出现多处，算它在——拒绝多命中是定位层的纪律，不是识别层的', async () => {
    const s: StateDef[] = [{ id: 'x', features: [{ kind: 'text', text: '发送' }] }]
    const twice = screenOf([
      { text: '发送', x: 10, y: 10, w: 40, h: 20 },
      { text: '发送', x: 500, y: 300, w: 40, h: 20 },
    ])
    expect(await new DesktopPerception(probe({ screen: twice })).identify(s)).toMatchObject({ states: ['x'] })
  })

  describe('where：同一个名字在列表和标题里各有一份时，认的是标题那一份', () => {
    // 坐标取自活体（QQ 默认会话列表那一屏，1023×653）：
    // 「我的手机」出现两处——右侧对话标题 (330,33) 和中间会话列表 (123,232)；
    // 锚点「导入手机相册」(916,35) 和标题同一行。
    const TITLE = { text: '我的手机', x: 330, y: 33, w: 69, h: 22 }
    const LIST = { text: '我的手机', x: 123, y: 232, w: 61, h: 18 }
    const ANCHOR = { text: '导入手机相册', x: 916, y: 35, w: 89, h: 17 }
    const convo: StateDef[] = [
      {
        id: 'qq/convo',
        features: [
          { kind: 'text', text: '我的手机', where: { anchor: { text: '导入手机相册' }, side: 'left', maxDist: 8 } },
        ],
      },
    ]

    it('标题在场 → 认出来', async () => {
      const p = new DesktopPerception(probe({ screen: screenOf([TITLE, LIST, ANCHOR]) }))
      expect(await p.identify(convo)).toMatchObject({ states: ['qq/convo'] })
    })

    it('只有列表里那一份（= 我其实在别人的对话里）→ 不认，这一格挡的是发错人', async () => {
      const p = new DesktopPerception(probe({ screen: screenOf([LIST, ANCHOR]) }))
      expect(await p.identify(convo)).toMatchObject({ states: null, reason: 'no-match' })
    })

    it('不带 where 的同一条判据会误判成命中——这是上面那一格的对照', async () => {
      const loose: StateDef[] = [{ id: 'qq/convo', features: [{ kind: 'text', text: '我的手机' }] }]
      const p = new DesktopPerception(probe({ screen: screenOf([LIST, ANCHOR]) }))
      expect(await p.identify(loose)).toMatchObject({ states: ['qq/convo'] })
    })

    it('距离超出 maxDist → 不认', async () => {
      const far: StateDef[] = [
        {
          id: 'qq/convo',
          features: [
            { kind: 'text', text: '我的手机', where: { anchor: { text: '导入手机相册' }, side: 'left', maxDist: 3 } },
          ],
        },
      ]
      const p = new DesktopPerception(probe({ screen: screenOf([TITLE, ANCHOR]) }))
      expect(await p.identify(far)).toMatchObject({ states: null })
    })

    it('方向反了 → 不认', async () => {
      const wrong: StateDef[] = [
        {
          id: 'qq/convo',
          features: [
            { kind: 'text', text: '我的手机', where: { anchor: { text: '导入手机相册' }, side: 'right' } },
          ],
        },
      ]
      const p = new DesktopPerception(probe({ screen: screenOf([TITLE, ANCHOR]) }))
      expect(await p.identify(wrong)).toMatchObject({ states: null })
    })
  })

  describe('image：文字答不了的那些（只有图标的按钮、焦点高亮、未读徽标）', () => {
    const PNG = Buffer.from('fake').toString('base64')
    const s: StateDef[] = [{ id: 'x', features: [{ kind: 'image', png: PNG }] }]

    it('分数过阈值就算在', async () => {
      const p = probe({ image: { rect: { x: 5, y: 5, w: 20, h: 20 }, score: 0.95 } })
      expect(await new DesktopPerception(p).identify(s)).toMatchObject({ states: ['x'] })
    })

    it('分数不过阈值就当没有——模板匹配总会回一个"最像的"，光看 non-null 等于没判', async () => {
      const p = probe({ image: { rect: { x: 5, y: 5, w: 20, h: 20 }, score: 0.4 } })
      expect(await new DesktopPerception(p).identify(s)).toMatchObject({ states: null })
    })

    it('不带 where 时一次 OCR 都不花——这一档的便宜正在这里', async () => {
      const p = probe({ image: { rect: { x: 0, y: 0, w: 10, h: 10 }, score: 0.99 } })
      await new DesktopPerception(p).identify(s)
      expect(p.reads).toBe(0)
    })

    it('带 where 时按命中框的位置再筛一道', async () => {
      const anchored: StateDef[] = [
        {
          id: 'x',
          features: [
            { kind: 'image', png: PNG, where: { anchor: { text: '导入手机相册' }, side: 'left', maxDist: 8 } },
          ],
        },
      ]
      const screen = screenOf([{ text: '导入手机相册', x: 916, y: 35, w: 89, h: 17 }])
      const near = probe({ screen, image: { rect: { x: 700, y: 33, w: 40, h: 22 }, score: 0.99 } })
      const far = probe({ screen, image: { rect: { x: 100, y: 500, w: 40, h: 22 }, score: 0.99 } })
      expect(await new DesktopPerception(near).identify(anchored)).toMatchObject({ states: ['x'] })
      expect(await new DesktopPerception(far).identify(anchored)).toMatchObject({ states: null })
    })
  })

  describe('group：跨组同时成立是正常的，同组撞车才是歧义', () => {
    const screen = screenOf(['搜索建议', '发送'])
    const middle: StateDef = { id: 'search', group: 'middle', features: [{ kind: 'text', text: '搜索建议' }] }
    const right: StateDef = { id: 'convo', group: 'right', features: [{ kind: 'text', text: '发送' }] }

    it('两个不同组的状态同时命中 → 两个都返回，不是 ambiguous', async () => {
      const r = await new DesktopPerception(probe({ screen })).identify([middle, right])
      expect(r).toMatchObject({ states: ['search', 'convo'] })
    })

    it('同组的两个同时命中 → ambiguous，且绝不从里面挑一个', async () => {
      const twin: StateDef = { id: 'search2', group: 'middle', features: [{ kind: 'text', text: '搜索建议' }] }
      const r = await new DesktopPerception(probe({ screen })).identify([middle, twin])
      expect(r).toMatchObject({ states: null, reason: 'ambiguous', candidates: ['search', 'search2'] })
    })

    it('没写 group 的都在同一个默认组里——存量图照旧两两互斥', async () => {
      const a: StateDef = { id: 'a', features: [{ kind: 'text', text: '搜索建议' }] }
      const b: StateDef = { id: 'b', features: [{ kind: 'text', text: '发送' }] }
      const r = await new DesktopPerception(probe({ screen })).identify([a, b])
      expect(r).toMatchObject({ states: null, reason: 'ambiguous' })
    })
  })

  it('一次 identify 只读一次屏——多条文字特征不重复付 OCR 的钱', async () => {
    const p = probe({ screen: screenOf(['aaa', 'bbb']) })
    await new DesktopPerception(p).identify([
      { id: 'x', features: [{ kind: 'text', text: 'aaa' }, { kind: 'text', text: 'bbb' }] },
    ])
    expect(p.reads).toBe(1)
  })

  it('网页特征混进桌面图会抛错', async () => {
    const p = new DesktopPerception(probe({}))
    await expect(p.identify([{ id: 'x', features: [{ kind: 'dom', selector: '.a' }] }])).rejects.toThrow(
      /判不了/,
    )
  })
})
