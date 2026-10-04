import { describe, it, expect } from 'vitest'
import { episodeNo, netdiskLabeller, rowOrigin, sortByEpisodeNo } from './playlistScope.ts'

const t = (title: string) => ({ title })
const titles = (rows: { title: string }[]) => rows.map((r) => r.title)

describe('episodeNo', () => {
  it('只认三位零填充——两位号是子节目的独立编号体系,不能混判', () => {
    expect(episodeNo('455.现代版木仓下留人')).toBe(455)
    expect(episodeNo('002.早期一集')).toBe(2)
    expect(episodeNo('07.甲木')).toBeNull()
    expect(episodeNo('年度特辑')).toBeNull()
  })
})

describe('sortByEpisodeNo', () => {
  it('把网盘补进来的下架集从顶端落回它的集号位置', () => {
    // 网盘条目没有发布时间 → 落库取采集时刻 → 全堆顶端
    const rows = [t('455.现代版木仓下留人'), t('947.现实中的一些怪侠'), t('456.后一集'), t('454.前一集')]
    expect(titles(sortByEpisodeNo(rows, (r) => r.title))).toEqual([
      '947.现实中的一些怪侠', '456.后一集', '455.现代版木仓下留人', '454.前一集',
    ])
  })

  it('不带集号的行**原地不动**,不被冲到末尾', () => {
    const rows = [t('947.甲'), t('年度特辑'), t('945.乙'), t('946.丙')]
    // 槽位 0/2/3 是带号行 → 它们之间按号降序;槽位 1 的「年度特辑」保持不动
    expect(titles(sortByEpisodeNo(rows, (r) => r.title))).toEqual([
      '947.甲', '年度特辑', '946.丙', '945.乙',
    ])
  })

  it('带号行不过半 → 整表不动(音乐歌单不受影响)', () => {
    const rows = [t('001.一'), t('晴天'), t('稻香'), t('七里香')]
    expect(titles(sortByEpisodeNo(rows, (r) => r.title))).toEqual(['001.一', '晴天', '稻香', '七里香'])
  })

  it('两位号的子节目集当作无号,不参与排序也不移位', () => {
    const rows = [t('947.甲'), t('07.甲木'), t('945.乙'), t('946.丙')]
    expect(titles(sortByEpisodeNo(rows, (r) => r.title))).toEqual(['947.甲', '07.甲木', '946.丙', '945.乙'])
  })
})

describe('rowOrigin / netdiskLabeller', () => {
  const item = (over: Record<string, unknown>) => ({ id: 'i', stream_id: 's', type: 'post', title: 't', ...over }) as never

  it('付费只认源站的 paid 标——补上音频后依然是付费集', () => {
    const paidPlayable = item({ source_id: 'lizhi-user', content: { archetype: 'audio', paid: true, media: [{ kind: 'audio', url: 'https://cdn/x.mp3' }] } })
    expect(rowOrigin(paidPlayable)).toEqual({ label: '付费', kind: 'paid' })
  })

  it('不可播但源站没说付费(如尚未开放的预告集) → 不标付费', () => {
    const forestall = item({ source_id: 'lizhi-user', content: { archetype: 'audio', media: [{ kind: 'image', url: 'https://cdn/c.jpg' }] } })
    expect(rowOrigin(forestall)).toBeUndefined()
  })

  it('网盘条目的字面取自挂载目录名,取不到才回落「网盘」', () => {
    const nd = item({ source_id: 'alist:alist-audio', content: { archetype: 'audio', media: [] } })
    const label = netdiskLabeller([
      { plugin_id: 'rsshub', source_template_id: 'lizhi/user/:id', params: { id: '123' } },
      { plugin_id: 'alist', source_template_id: 'alist-audio', params: { path: '/quark/From Stream/怡楽播客/下架' } },
    ])
    expect(rowOrigin(nd, label)).toEqual({ label: '下架', kind: 'netdisk' })
    expect(rowOrigin(nd)).toEqual({ label: '网盘', kind: 'netdisk' })
  })

  it('免费直链集不标', () => {
    expect(rowOrigin(item({ source_id: 'lizhi-user', content: { archetype: 'audio', media: [{ kind: 'audio', url: 'https://cdn/f.mp3' }] } }))).toBeUndefined()
  })
})
