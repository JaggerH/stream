import { describe, it, expect } from 'vitest'
import { indexRowOf, sameStoryInbox, worthChecking, byPublishOrder, INBOX_PROFILE, type IndexRow } from './inbox.ts'
import { textSketch } from '../text/shingle.ts'
import type { StreamItem } from '../types.ts'

const row = (o: Partial<IndexRow> & { itemId: string; streamId: string; title: string; text?: string }): IndexRow => ({
  titleFold: o.title.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, ''),
  ts: '2026-08-13T00:00:00Z',
  ...o,
  ...(o.text ? { textSig: textSketch(o.text), textSource: 'stt' } : {}),
})

/** 一段真实形状的转写。 */
const SPEECH = `这是我这两天做出来的一个小产品 我来给大家做一个简单的介绍
就是我们这个主要是去监控全球的媒体信息 然后并且能通过这些信息来去观察舆情背后的议题
那么我们一共监控了172个国家和地区 包括408家主流的媒体`

const OTHER_SPEECH = `今天我们来聊一聊完全不同的另一件事情，关于怎么挑选一台适合自己的相机，
以及镜头该怎么配，预算有限的时候优先买什么。`

describe('indexRowOf —— 候选信号在入库那一跳抠好', () => {
  const item = (over: Partial<StreamItem>): StreamItem =>
    ({
      id: 'i1', stream_id: 's1', source_type: 'rsshub-bridge', source_route: '/x',
      fetched_at: '2026-08-13T01:00:00Z', timestamp: '2026-08-12T00:00:00Z',
      title: '标题', raw: {}, ...over,
    }) as StreamItem

  it('时长从 content.media 抠（只用来缩候选，不参与结论）', () => {
    expect(indexRowOf(item({ content: { archetype: 'video', media: [{ kind: 'video', duration_s: 61.4 }] } as never })).durationS).toBe(61)
  })

  it('时间取 timestamp，缺了才退到 fetched_at', () => {
    expect(indexRowOf(item({})).ts).toBe('2026-08-12T00:00:00Z')
    expect(indexRowOf(item({ timestamp: '' })).ts).toBe('2026-08-13T01:00:00Z')
  })

  it('**入库时没有文本**——文本是后台补的', () => {
    expect(indexRowOf(item({})).textSig).toBeUndefined()
  })
})

describe('sameStoryInbox —— 判据是文本', () => {
  const douyin = row({ itemId: 'd1', streamId: 'douyin:me', title: '谁在操纵舆情｜观澜介绍', durationS: 96, text: SPEECH })

  it('两边转写几乎一样 → 同一条内容（标题不同也不影响）', () => {
    const bili = row({ itemId: 'b1', streamId: 'bili:me', title: '完全换了个说法的标题', durationS: 96, text: `${SPEECH} 记得点赞关注哦` })
    const v = sameStoryInbox(douyin, bili, INBOX_PROFILE)
    expect(v.kind).toBe('same')
    expect(v.kind === 'same' && v.evidence.kind).toBe('text-identity')
  })

  it('**时长一样但说的不是一回事 → 不并**（时长从来不是身份）', () => {
    const other = row({ itemId: 'x', streamId: 's2', title: '另一条视频', durationS: 96, text: OTHER_SPEECH })
    expect(sameStoryInbox(douyin, other, INBOX_PROFILE).kind).toBe('different')
  })

  it('标题一模一样但正文不同 → 也不并（标题同样不是身份）', () => {
    const sameTitle = row({ itemId: 'x', streamId: 's2', title: '谁在操纵舆情｜观澜介绍', text: OTHER_SPEECH })
    expect(sameStoryInbox(douyin, sameTitle, INBOX_PROFILE).kind).toBe('different')
  })

  it('**缺文本 → need-text，不是 different**：「没依据」和「不像」的处置完全相反', () => {
    const noText = row({ itemId: 'x', streamId: 's2', title: '疑似同一条', durationS: 96 })
    const v = sameStoryInbox(douyin, noText, INBOX_PROFILE)
    expect(v.kind).toBe('need-text')
    expect(v.kind === 'need-text' && v.who.map((r) => r.itemId)).toEqual(['x'])
  })

  it('同链接是事实，不用等文本', () => {
    const a = row({ itemId: 'a', streamId: 's1', title: '甲', urlKey: 'x.com/p/1' })
    const b = row({ itemId: 'b', streamId: 's2', title: '乙完全不同', urlKey: 'x.com/p/1' })
    const v = sameStoryInbox(a, b, INBOX_PROFILE)
    expect(v.kind === 'same' && v.evidence.kind).toBe('url-identity')
  })

  it('**同一个 Stream 内永不归堆**，也不去取文本', () => {
    const sameStream = row({ itemId: 'b1', streamId: 'douyin:me', title: '任何标题', text: SPEECH })
    expect(sameStoryInbox(douyin, sameStream, INBOX_PROFILE).kind).toBe('different')
  })

  it('集号对不上 → 一票否决，且**在取文本之前**（省掉一次十几秒的转写）', () => {
    const a = row({ itemId: 'a', streamId: 's1', title: '怡楽播客-209.十五谈身边灵异事', durationS: 3600 })
    const b = row({ itemId: 'b', streamId: 's2', title: '怡楽播客-210.十六谈身边灵异事', durationS: 3600 })
    expect(sameStoryInbox(a, b, INBOX_PROFILE).kind).toBe('different')
  })
})

describe('worthChecking —— 只缩范围，不下结论', () => {
  const a = row({ itemId: 'a', streamId: 's1', title: '谁在操纵舆情 观澜介绍', durationS: 96 })

  it('时长接近 → 值得取文本比一比', () => {
    expect(worthChecking(a, row({ itemId: 'b', streamId: 's2', title: '毫不相干的标题', durationS: 97 }), INBOX_PROFILE)).toBe(true)
  })

  it('没有时长但标题够像 → 也值得（纯文字内容唯一的入口）', () => {
    expect(worthChecking(a, row({ itemId: 'b', streamId: 's2', title: '谁在操纵舆情：观澜' }), INBOX_PROFILE)).toBe(true)
  })

  it('既不同长也不像 → 不值得为它花一次转写', () => {
    expect(worthChecking(a, row({ itemId: 'b', streamId: 's2', title: '今天股市收评', durationS: 300 }), INBOX_PROFILE)).toBe(false)
  })

  it('同 Stream / 集号冲突 → 直接不看', () => {
    expect(worthChecking(a, row({ itemId: 'b', streamId: 's1', title: '谁在操纵舆情 观澜介绍', durationS: 96 }), INBOX_PROFILE)).toBe(false)
    expect(worthChecking(
      row({ itemId: 'a', streamId: 's1', title: '第209期', durationS: 96 }),
      row({ itemId: 'b', streamId: 's2', title: '第210期', durationS: 96 }),
      INBOX_PROFILE,
    )).toBe(false)
  })
})

describe('byPublishOrder —— 谁先发的', () => {
  it('按发布时间排，第一个就是首发', () => {
    const late = row({ itemId: 'late', streamId: 's2', title: 'x', ts: '2026-08-13T10:00:00Z' })
    const early = row({ itemId: 'early', streamId: 's1', title: 'x', ts: '2026-08-13T08:00:00Z' })
    expect(byPublishOrder([late, early]).map((r) => r.itemId)).toEqual(['early', 'late'])
  })

  it('同一时刻不硬分先后（不编造精度）', () => {
    const a = row({ itemId: 'a', streamId: 's1', title: 'x', ts: '2026-08-13T08:00:00Z' })
    const b = row({ itemId: 'b', streamId: 's2', title: 'x', ts: '2026-08-13T08:00:00Z' })
    expect(byPublishOrder([a, b]).map((r) => r.itemId)).toEqual(['a', 'b'])
    expect(byPublishOrder([b, a]).map((r) => r.itemId)).toEqual(['b', 'a'])
  })
})
