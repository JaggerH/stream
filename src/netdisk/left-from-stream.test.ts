import { describe, it, expect } from 'vitest'
import { AUTHORITY_ITEM_LIMIT, authorityFromStream, bindingLeftFromStream } from './left-from-stream.ts'
import type { StoredItem } from '../item-store.ts'

/** 最小 StoredItem 夹具——只带这两支左侧真正读的字段。 */
function item(over: Partial<StoredItem> & Pick<StoredItem, 'id'>): StoredItem {
  return {
    stream_id: 's1',
    source_type: 'rsshub-bridge',
    source_route: '/x',
    fetched_at: '2026-07-31T00:00:00Z',
    timestamp: '2026-07-31T00:00:00Z',
    title: over.title ?? `t-${over.id}`,
    raw: {},
    type: 'feed',
    ...over,
  } as StoredItem
}

const deps = (items: StoredItem[]) => ({ recentItems: () => items })
/** 权威支多两样：货架名册（网盘成员产出的 source id），以及 newest-first + limit 的取数契约。
 *  缺省货架 = 这条流没挂网盘成员。夹具按入库顺序（asc）写，这里反过来给。 */
const authorityDeps = (items: StoredItem[], shelf: string[] = []) => ({
  recentItems: (_s: string, limit: number) => [...items].reverse().slice(0, limit),
  shelfSourceIds: () => new Set(shelf),
})

describe('bindingLeftFromStream', () => {
  it('滤掉 muted', () => {
    const left = bindingLeftFromStream(deps([item({ id: 'a', muted: { rule: 'kw' } as never })]))('s1')
    expect(left).toEqual([])
  })

  it('带 enclosure_url 的免费集不进绑定左侧（源站自己能播）', () => {
    const left = bindingLeftFromStream(
      deps([item({ id: 'a', raw: { enclosure_url: 'https://cdn.lizhi.fm/audio/x/111_hd.mp3' } })]),
    )('s1')
    expect(left).toEqual([])
  })

  it('有 track ref → leftKey 是 platform:id', () => {
    const left = bindingLeftFromStream(
      deps([
        item({
          id: 'a',
          title: '第一期',
          content: { archetype: 'audio', media: [{ kind: 'audio', platform: 'lizhi', track_id: '111', duration_s: 600 }] } as never,
        }),
      ]),
    )('s1')
    expect(left).toEqual([{ leftKey: 'lizhi:111', title: '第一期', durationS: 600, paid: undefined }])
  })

  it('无结构化 track ref 时不从 raw.link 猜（facility 知识不住源码）→ 落到 item:<id> 键', () => {
    const left = bindingLeftFromStream(deps([item({ id: 'a', title: '第二期', raw: { link: 'https://www.lizhi.fm/vod/222' } })]))('s1')
    expect(left).toEqual([{ leftKey: 'item:a', title: '第二期', durationS: undefined, paid: undefined }])
  })

  it('无 ref 且无音频 media → item:<id> 键', () => {
    const left = bindingLeftFromStream(
      deps([item({ id: 'a', title: '第 3 集', content: { archetype: 'video', media: [{ kind: 'video', duration_s: 1800 }] } as never })]),
    )('s1')
    expect(left).toEqual([{ leftKey: 'item:a', title: '第 3 集', durationS: 1800, paid: undefined }])
  })

  it('无 ref 但有音频 media → 不出 item 键（音频歌单只认 track）', () => {
    const left = bindingLeftFromStream(
      deps([item({ id: 'a', title: '无名音频', content: { archetype: 'audio', media: [{ kind: 'audio', url: '/x.mp3' }] } as never })]),
    )('s1')
    expect(left).toEqual([])
  })

  it('paid 透传', () => {
    const left = bindingLeftFromStream(
      deps([item({ id: 'a', title: '付费集', content: { archetype: 'video', paid: true, media: [] } as never })]),
    )('s1')
    expect(left[0]?.paid).toBe(true)
  })
})

describe('authorityFromStream', () => {
  it('滤掉 muted 与无标题；其余全量（含带 enclosure 的免费集）', () => {
    const left = authorityFromStream(
      authorityDeps([
        // 带 enclosure 的免费集：normalize 会把 enclosure_url 落进 `content.media[].url`
        // （活体核对过怡楽全流 1032 条，"有 enclosure、media 却没 url" 的一条都没有）。
        item({
          id: 'a', title: '免费集',
          raw: { enclosure_url: 'https://cdn.lizhi.fm/audio/x/111_hd.mp3' },
          content: { archetype: 'audio', media: [{ kind: 'audio', url: 'https://cdn.lizhi.fm/audio/x/111_hd.mp3' }] } as never,
        }),
        item({ id: 'b', muted: { rule: 'kw' } as never }),
        item({ id: 'c', title: '' }),
      ]),
    )('s1').entries
    expect(left).toEqual([{ leftKey: 'item:a', title: '免费集', durationS: undefined, paid: false, needsSupply: false }])
  })

  // `paid` 只是**解释原因**那一位（账本/证据卡上那句「源站要钱」），处置层不读它。
  // 站外条目读得出就是 false，所以这一支只产 true/false，一条 undefined 都不该有。
  it('没人说要钱的集，paid 是显式 false，不是 undefined', () => {
    const left = authorityFromStream(
      authorityDeps([item({ id: 'a', title: '免费集', content: { archetype: 'audio', media: [] } as never })]),
    )('s1').entries
    expect(left[0]?.paid).toBe(false)
  })

  it('durationS 取第一条 audio media 的时长（非音频不算）', () => {
    const left = authorityFromStream(
      authorityDeps([
        item({
          id: 'a',
          title: '一集',
          content: {
            archetype: 'audio',
            media: [{ kind: 'image', url: '/cover.jpg' }, { kind: 'audio', duration_s: 900 }, { kind: 'audio', duration_s: 123 }],
          } as never,
        }),
      ]),
    )('s1').entries
    expect(left[0]?.durationS).toBe(900)
  })

  it('paid 透传', () => {
    const left = authorityFromStream(authorityDeps([item({ id: 'a', title: '付费集', content: { archetype: 'audio', paid: true, media: [] } as never })]))('s1').entries
    expect(left[0]?.paid).toBe(true)
  })

  it('网盘成员产出的条目（货架层）不进权威——否则自己挪去下架的文件会以「节目单上的一集」回流', () => {
    const left = authorityFromStream(
      authorityDeps(
        [
          item({ id: 'a', title: '第一期', source_id: 'lizhi-user' }),
          item({ id: 'b', title: '第二期（已挪去下架）', source_id: 'alist:alist-audio' }),
        ],
        ['alist:alist-audio'],
      ),
    )('s1').entries
    expect(left.map((e) => e.leftKey)).toEqual(['item:a'])
  })

  it('源站条目原样保留（source_id 缺失的老条目也算节目单层）', () => {
    const left = authorityFromStream(
      authorityDeps(
        [item({ id: 'a', title: '第一期', source_id: 'lizhi-user' }), item({ id: 'b', title: '老条目无 source_id' })],
        ['alist:alist-audio'],
      ),
    )('s1').entries
    expect(left.map((e) => e.leftKey)).toEqual(['item:a', 'item:b'])
  })

  it('没有网盘成员的 stream 行为不变（空货架名册不剔任何东西）', () => {
    const left = authorityFromStream(
      authorityDeps([item({ id: 'a', title: '第一期', source_id: 'lizhi-user' }), item({ id: 'b', title: '第二期', source_id: 'alist:alist-audio' })]),
    )('s1').entries
    expect(left.map((e) => e.leftKey)).toEqual(['item:a', 'item:b'])
  })

  it('条目数到上限 → truncated:true 且保留的是最新入库的那一批（倒序取、再倒回来）', () => {
    // recentItems 的契约是 newest-first、最多 limit 条。夹具造 limit+1 条，最老那条 id='n0'。
    const many = Array.from({ length: AUTHORITY_ITEM_LIMIT + 1 }, (_, i) => item({ id: `n${i}` }))
    const newestFirst = [...many].reverse() // n5000 … n0
    const listing = authorityFromStream({
      recentItems: (_s, limit) => newestFirst.slice(0, limit),
      shelfSourceIds: () => new Set(),
    })('s1')
    expect(listing.truncated).toBe(true)
    expect(listing.entries).toHaveLength(AUTHORITY_ITEM_LIMIT)
    expect(listing.entries[0]!.leftKey).toBe('item:n1') // 最老的 n0 被截掉，不是最新的 n5000
    expect(listing.entries.at(-1)!.leftKey).toBe('item:n5000')
    expect(listing.source).toBe('stream:s1')
  })

  it('没到上限 → 不带 truncated 字段（缺席，不是 false）', () => {
    const listing = authorityFromStream({
      recentItems: () => [item({ id: 'b' }), item({ id: 'a' })],
      shelfSourceIds: () => new Set(),
    })('s1')
    expect('truncated' in listing).toBe(false)
    expect(listing.entries.map((e) => e.leftKey)).toEqual(['item:a', 'item:b']) // 倒回入库顺序
  })
})

/**
 * **`needsSupply` 的判据：这一集自己带没带可播地址**（不是「要不要钱」）。
 *
 * 删是不可逆的、留着只占空间，所以默认必须是「要供货」，只有**看见**一个自带可播地址的媒体项
 * 才敢说「不用供货」。`paid` 答不了这个问题：全仓唯一写它的地方（`content/normalize.ts` 的
 * `withPaid`）只在 `price > 0` 时写 `true`，其余一律不写——「源站没给音频地址、但也不要钱」的
 * app 独占集（活体：怡楽 948/949，`media:[{kind:'audio',resolveOnly:true}]`、无 `url`、无 `paid`）
 * 于是被读成「免费 = 源站自己能播」，而它源站根本放不出，网盘那份是唯一来源。
 *
 * **判据不写死 `audio`**：播客和视频流走同一句话，将来加 archetype 不必加分支。但也**不是
 * 「media 里有任意 url」**——封面图（`kind:'image'`）自带 `url` 却一秒都放不出来。活体实测：
 * 全库 3295 条（36 条流）是「无可播地址、但 media 里有别的 url」，其中就有已绑网盘的
 * `tencent-talkshow-friends-season3`（210 条，media 只有一张封面图）——按「任意 url」判，
 * 这条绑定的网盘文件会被整库判成冗余。所以只认**可播那两类**（`audio`/`video`）的 `url`。
 */
describe('authorityFromStream: needsSupply（默认要供货，见到可播地址才免）', () => {
  const audio = (over: Record<string, unknown>) => ({ archetype: 'audio', media: [{ kind: 'audio', ...over }] } as never)

  it('自带可播音频地址 → 不用供货', () => {
    const left = authorityFromStream(authorityDeps([item({ id: 'a', title: '免费集', content: audio({ url: 'https://cdn/x.mp3' }) })]))('s1').entries
    expect(left[0]?.needsSupply).toBe(false)
  })

  // 本次修复的核心：既没有可播地址、也没人说它要钱。旧判据（paid !== false）把它算成「源站
  // 自己能播」→ 网盘副本判冗余删掉，而源站压根放不出。
  it('没有可播地址、也不要钱（app 独占集）→ 要供货', () => {
    const left = authorityFromStream(
      authorityDeps([item({ id: 'a', title: '948.这位特别好玩儿的机车博主', content: audio({ resolveOnly: true, duration_s: 5497 }) })]),
    )('s1').entries
    expect(left[0]?.needsSupply).toBe(true)
  })

  it('没有可播地址、要钱 → 要供货', () => {
    const left = authorityFromStream(
      authorityDeps([item({ id: 'a', title: '付费集', content: { archetype: 'audio', paid: true, media: [{ kind: 'audio' }] } as never })]),
    )('s1').entries
    expect(left[0]?.needsSupply).toBe(true)
  })

  it('media 整个缺席 → 要供货', () => {
    const left = authorityFromStream(authorityDeps([item({ id: 'a', title: '光秃秃一条' })]))('s1').entries
    expect(left[0]?.needsSupply).toBe(true)
  })

  // 判据不能松成「media 里有任意 url」：封面图带 url 但放不出来。活体 tencent-talkshow 那条
  // 已绑网盘的流，每条 item 的 media 就只有一张封面图。
  it('只有封面图（有 url、但放不出来）→ 要供货', () => {
    const left = authorityFromStream(
      authorityDeps([
        item({ id: 'a', title: '先导片', content: { archetype: 'video', media: [{ kind: 'image', url: 'https://vpic/cover.jpg' }] } as never }),
      ]),
    )('s1').entries
    expect(left[0]?.needsSupply).toBe(true)
  })

  // 判据不写死 audio：视频流自带播放地址，同一句话就该覆盖。
  it('自带可播视频地址 → 不用供货', () => {
    const left = authorityFromStream(
      authorityDeps([
        item({
          id: 'a', title: '一集',
          content: { archetype: 'video', media: [{ kind: 'image', url: '/cover.jpg' }, { kind: 'video', url: 'https://cdn/x.mp4' }] } as never,
        }),
      ]),
    )('s1').entries
    expect(left[0]?.needsSupply).toBe(false)
  })

  // `paid` 退回「解释原因」的角色：它照旧透传，但不再是 needsSupply 的判据。
  // 付费且**有**可播地址（源站给了试听）→ 判据看地址，不看价钱。
  it('paid 与 needsSupply 各说各话：有地址就不用供货，哪怕标着付费', () => {
    const left = authorityFromStream(
      authorityDeps([
        item({ id: 'a', title: '付费但给了地址', content: { archetype: 'audio', paid: true, media: [{ kind: 'audio', url: 'https://cdn/x.mp3' }] } as never }),
      ]),
    )('s1').entries
    expect(left[0]).toMatchObject({ paid: true, needsSupply: false })
  })
})
