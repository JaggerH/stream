import { describe, it, expect } from 'vitest'
import { fmtDateTime, hasTrackMeta, trackMetaDescription, trackMetaFields } from './trackMeta.ts'
import type { TrackTableRow } from './playlistScope.ts'
import type { Item } from './types.ts'

function item(over: Partial<Item>): Item {
  return {
    id: 'i1', stream_id: 's1', type: 'post', title: 't',
    timestamp: '2026-08-02T16:00:01.000Z', fetched_at: '2026-08-04T02:51:57.722Z',
    ...over,
  } as Item
}
function row(over: Partial<TrackTableRow>): TrackTableRow {
  return { id: 'r1', title: '950.荒唐且搞笑的案件', playIndex: 0, ...over }
}

describe('fmtDateTime', () => {
  it('本地时区的 YYYY-MM-DD HH:MM', () => {
    // 用本地构造避开时区依赖：断言的是格式与取值，不是某个固定时区的结果。
    const d = new Date(2026, 7, 2, 9, 5)
    expect(fmtDateTime(d.toISOString())).toBe('2026-08-02 09:05')
  })
  it('缺失或非法一律空串', () => {
    expect(fmtDateTime(undefined)).toBe('')
    expect(fmtDateTime('not-a-date')).toBe('')
  })
})

describe('trackMetaFields', () => {
  it('作者/专辑/时长按序给出，缺的那项不占行', () => {
    const fields = trackMetaFields(row({ author: '怡楽播客', durationS: 2730 }))
    expect(fields.map((f) => f.label)).toEqual(['作者', '时长'])
    expect(fields.map((f) => f.value)).toEqual(['怡楽播客', '45:30'])
  })

  it('源站给了发布时间 → 标签是「发布时间」', () => {
    const fields = trackMetaFields(row({ sourceItem: item({}) }))
    expect(fields).toContainEqual({ label: '发布时间', value: expect.any(String) })
  })

  // 网盘目录采进来的条目没有发布时间（AList 只给文件名和大小），落库取的是采集时刻——
  // 这时 timestamp === fetched_at，写「发布时间」就是在把入库时刻冒充成播出时刻。
  it('timestamp 等于 fetched_at（源站没给发布时间）→ 标签改成「入库时间」', () => {
    const same = '2026-08-04T02:51:57.722Z'
    const fields = trackMetaFields(row({ sourceItem: item({ timestamp: same, fetched_at: same }) }))
    expect(fields.map((f) => f.label)).toContain('入库时间')
    expect(fields.map((f) => f.label)).not.toContain('发布时间')
  })

  it('没有 sourceItem 的曲目行（我的喜欢/播单里的 track 成员）只给行自带的那几项', () => {
    const fields = trackMetaFields(row({ author: '周杰伦', album: '范特西' }))
    expect(fields.map((f) => f.label)).toEqual(['作者', '专辑'])
  })
})

describe('trackMetaDescription', () => {
  it('优先 content.text（保留换行），无则回落 body_text', () => {
    expect(trackMetaDescription(row({ sourceItem: item({ content: { archetype: 'audio', text: '主播：小伟\n\n后期：许先生' }, body_text: 'x' }) })))
      .toBe('主播：小伟\n\n后期：许先生')
    expect(trackMetaDescription(row({ sourceItem: item({ body_text: ' 只有 body_text ' }) }))).toBe('只有 body_text')
  })
  it('都没有 → 空串', () => {
    expect(trackMetaDescription(row({}))).toBe('')
  })

  // 网易云的正文就是一段「歌手/专辑/发行日期」。前两行上面已经列成字段了，照抄一遍会把
  // 只有正文才有的发行日期淹掉——那恰恰是这段正文唯一的新信息。
  it('已经列成字段的行从简介里删掉，只留正文独有的那些', () => {
    const text = '歌手：Øfdream\n专辑：Øfdream: Anthology, Pt. 1\n发行日期：10/20/2017'
    const r = row({ author: 'Øfdream', album: 'Øfdream: Anthology, Pt. 1', sourceItem: item({ content: { archetype: 'audio', text } }) })
    expect(trackMetaDescription(r)).toBe('发行日期：10/20/2017')
  })

  it('删的判据是值相等而不是标签名——标签撞了但值不同的行留着', () => {
    const r = row({ author: '怡楽播客', sourceItem: item({ content: { archetype: 'audio', text: '主播：小伟、阿达' } }) })
    expect(trackMetaDescription(r)).toBe('主播：小伟、阿达')
  })
})

describe('hasTrackMeta', () => {
  it('只有一个标题的行没有可讲的 → 不挂图标', () => {
    expect(hasTrackMeta(row({}))).toBe(false)
  })
  it('有任意一项元数据、简介或原文链接 → 挂', () => {
    expect(hasTrackMeta(row({ album: '范特西' }))).toBe(true)
    expect(hasTrackMeta(row({ sourceUrl: 'https://www.lizhi.fm/vod/1' }))).toBe(true)
    expect(hasTrackMeta(row({ sourceItem: item({ body_text: '简介' }) }))).toBe(true)
  })
})
