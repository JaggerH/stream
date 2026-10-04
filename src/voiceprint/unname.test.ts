import { describe, it, expect } from 'vitest'
import { SpeakerRegistryStore } from './store.ts'
import { revertPersonNaming } from './unname.ts'

const mk = () => new SpeakerRegistryStore(':memory:')

describe('revertPersonNaming — 删人时撤回已写进时间线的名字字面量', () => {
  it('反向映射可恢复：还原成 enroll 时的原簇号', () => {
    const s = mk()
    const p = s.createPerson('庞博')
    s.putItemCluster('ep1', 'SPEAKER_03', [1, 0], 'v1')
    s.putItemTimeline('ep1', [
      { start: 0, end: 100, speaker: 'SPEAKER_03' },
      { start: 100, end: 200, speaker: 'SPEAKER_05' },
    ])
    // enroll：簇 → 人名 + 落账
    s.enrollFromCluster('ep1', 'SPEAKER_03', p.id)
    s.renameInTimeline('ep1', 'SPEAKER_03', '庞博')
    s.recomputeItemAppearances('ep1', s.getItemTimeline('ep1'))
    expect(s.listAppearancesForPersons([p.id], 0)).toHaveLength(1)

    const out = revertPersonNaming(s, p.id)

    expect(out.items).toEqual(['ep1'])
    expect(s.getItemTimeline('ep1').map((x) => x.speaker)).toEqual(['SPEAKER_03', 'SPEAKER_05'])
    expect(s.listAppearancesForPersons([p.id], 0)).toEqual([])
  })

  it('反向映射恢复不了（无声纹来源，如自动认名的 item）：用不撞车的顺延匿名标签', () => {
    const s = mk()
    const p = s.createPerson('庞博')
    // 该 item 上没有 enroll 过（自动匹配归的名），也没留下簇代表
    s.putItemTimeline('ep9', [
      { start: 0, end: 100, speaker: '庞博' },
      { start: 100, end: 200, speaker: 'SPEAKER_04' },
    ])
    s.recomputeItemAppearances('ep9', [
      { start: 0, end: 100, speaker: '庞博' },
      { start: 100, end: 200, speaker: 'SPEAKER_04' },
    ])

    const out = revertPersonNaming(s, p.id)

    expect(out.items).toEqual(['ep9'])
    const labels = s.getItemTimeline('ep9').map((x) => x.speaker)
    // 现存最大簇号是 04 → 顺延 05，绝不与 SPEAKER_04 相撞，也不再是人名
    expect(labels).toEqual(['SPEAKER_05', 'SPEAKER_04'])
    expect(s.listAppearancesForPersons([p.id], 0)).toEqual([])
  })

  it('同一 item 上多个簇都认成了同一人 → 归成一个顺延标签（不猜哪段属于哪簇）', () => {
    const s = mk()
    const p = s.createPerson('庞博')
    s.putItemCluster('ep2', 'SPEAKER_00', [1, 0], 'v1')
    s.putItemCluster('ep2', 'SPEAKER_01', [0, 1], 'v1')
    s.enrollFromCluster('ep2', 'SPEAKER_00', p.id)
    s.enrollFromCluster('ep2', 'SPEAKER_01', p.id)
    s.putItemTimeline('ep2', [
      { start: 0, end: 100, speaker: '庞博' },
      { start: 100, end: 200, speaker: '庞博' },
    ])
    s.recomputeItemAppearances('ep2', [{ start: 0, end: 200, speaker: '庞博' }])

    revertPersonNaming(s, p.id)

    const labels = s.getItemTimeline('ep2').map((x) => x.speaker)
    expect(new Set(labels).size).toBe(1)
    expect(labels[0]).toBe('SPEAKER_02') // 现存 00/01 → 顺延 02
    expect(s.listAppearancesForPersons([p.id], 0)).toEqual([])
  })

  it('多个 item 都写过这个人名 → 一次全撤；别人的名字和账不动', () => {
    const s = mk()
    const p = s.createPerson('庞博')
    const other = s.createPerson('徐志胜')
    for (const [item, cluster] of [['ep1', 'SPEAKER_00'], ['ep2', 'SPEAKER_07']] as const) {
      s.putItemCluster(item, cluster, [1, 0], 'v1')
      s.enrollFromCluster(item, cluster, p.id)
      s.putItemTimeline(item, [
        { start: 0, end: 100, speaker: '庞博' },
        { start: 100, end: 200, speaker: '徐志胜' },
      ])
      s.recomputeItemAppearances(item, [
        { start: 0, end: 100, speaker: '庞博' },
        { start: 100, end: 200, speaker: '徐志胜' },
      ])
    }

    const out = revertPersonNaming(s, p.id)

    expect(out.items.sort()).toEqual(['ep1', 'ep2'])
    expect(s.getItemTimeline('ep1').map((x) => x.speaker)).toEqual(['SPEAKER_00', '徐志胜'])
    expect(s.getItemTimeline('ep2').map((x) => x.speaker)).toEqual(['SPEAKER_07', '徐志胜'])
    expect(s.listAppearancesForPersons([p.id], 0)).toEqual([])
    expect(s.listAppearancesForPersons([other.id], 0)).toHaveLength(2) // 同 item 里别人的账保住
  })

  it('没有时间线的 item（账悬空）→ 撤不了字面量，但账兜底清掉', () => {
    // 收敛后时间线是唯一存储；存量迁移做完不该有「只有抄件有名字」的 item。
    // 万一有（迁移前的残账），这里保证不炸、账不悬空。
    const s = mk()
    const p = s.createPerson('庞博')
    s.recomputeItemAppearances('ghost', [{ start: 0, end: 100, speaker: '庞博' }])

    const out = revertPersonNaming(s, p.id)

    expect(out.items).toEqual([])
    expect(s.listAppearancesForPersons([p.id], 0)).toEqual([])
  })

  it('撤销不动 pending（待确认抽名）机制', () => {
    const s = mk()
    const p = s.createPerson('庞博')
    s.enqueuePendingName({ itemId: 'ep1', cluster: 'SPEAKER_09', name: '别人', evidence: 'e', atSeconds: 1 })
    s.putItemTimeline('ep1', [{ start: 0, end: 100, speaker: '庞博' }])
    s.recomputeItemAppearances('ep1', [{ start: 0, end: 100, speaker: '庞博' }])

    revertPersonNaming(s, p.id)

    expect(s.listPendingNames('ep1').map((x) => x.name)).toEqual(['别人'])
  })

  it('人不存在 / 从没写过任何名字 → 空操作，不炸', () => {
    const s = mk()
    expect(revertPersonNaming(s, 'nobody').items).toEqual([])
    const p = s.createPerson('无名')
    expect(revertPersonNaming(s, p.id).items).toEqual([])
  })
})
