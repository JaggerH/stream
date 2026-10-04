import { describe, it, expect } from 'vitest'
import { SpeakerRegistryStore } from './store.ts'

const mk = () => new SpeakerRegistryStore(':memory:')

describe('SpeakerRegistryStore', () => {
  it('creates and lists persons', () => {
    const s = mk()
    const p = s.createPerson('庞博', ['pangbo'])
    expect(p.id).toBeTruthy()
    expect(p.aliases).toEqual(['pangbo'])
    expect(s.listPersons().map((x) => x.name)).toEqual(['庞博'])
    expect(s.getPerson(p.id)?.name).toBe('庞博')
  })

  it('match returns the closest person, same model version only', () => {
    const s = mk()
    const a = s.createPerson('A')
    const b = s.createPerson('B')
    s.addVoiceprint(a.id, [1, 0], 'v1', 'seed')
    s.addVoiceprint(b.id, [0, 1], 'v1', 'seed')
    const m = s.match([0.9, 0.1], 'v1')
    expect(m[0].personId).toBe(a.id)
    expect(m[0].score).toBeGreaterThan(m[1].score)
  })

  it('match ignores voiceprints of a different model version', () => {
    const s = mk()
    const a = s.createPerson('A')
    s.addVoiceprint(a.id, [1, 0], 'v1', 'seed')
    expect(s.match([1, 0], 'v2')).toEqual([])
  })

  it('a person with multiple prints scores by its best', () => {
    const s = mk()
    const a = s.createPerson('A')
    s.addVoiceprint(a.id, [1, 0], 'v1', 'ep1')
    s.addVoiceprint(a.id, [0, 1], 'v1', 'ep2')
    expect(s.match([0, 1], 'v1')[0].score).toBeCloseTo(1, 6)
  })

  it('deletePerson cascades voiceprints', () => {
    const s = mk()
    const a = s.createPerson('A')
    s.addVoiceprint(a.id, [1, 0], 'v1', 'seed')
    s.deletePerson(a.id)
    expect(s.listPersons()).toEqual([])
    expect(s.match([1, 0], 'v1')).toEqual([])
  })

  it('enrollFromCluster reads a stored cluster embedding into a voiceprint', () => {
    const s = mk()
    const a = s.createPerson('A')
    s.putItemCluster('item1', 'SPEAKER_00', [0.5, 0.5], 'v1')
    const vp = s.enrollFromCluster('item1', 'SPEAKER_00', a.id)
    expect(vp).not.toBeNull()
    expect(s.match([0.5, 0.5], 'v1')[0].personId).toBe(a.id)
  })

  it('enrollFromCluster returns null for an unknown cluster', () => {
    const s = mk()
    const a = s.createPerson('A')
    expect(s.enrollFromCluster('nope', 'SPEAKER_00', a.id)).toBeNull()
  })

  // 删 transcript 时顺带清该 item 的 diarization 暂存向量(item_clusters 无界增长的收口)。
  it('deleteItemClusters removes only the given item clusters', () => {
    const s = mk()
    s.putItemCluster('item1', 'SPEAKER_00', [0.1, 0.2], 'v1')
    s.putItemCluster('item1', 'SPEAKER_01', [0.3, 0.4], 'v1')
    s.putItemCluster('item2', 'SPEAKER_00', [0.5, 0.6], 'v1')
    s.deleteItemClusters('item1')
    expect(s.getItemCluster('item1', 'SPEAKER_00')).toBeNull()
    expect(s.getItemCluster('item1', 'SPEAKER_01')).toBeNull()
    expect(s.getItemCluster('item2', 'SPEAKER_00')).not.toBeNull() // 只删指定 item
  })
})

// 演职员表查无此人的名字：待确认队列（问用户一次，不静默丢弃）。
describe('SpeakerRegistryStore pending intro names', () => {
  const rec = (over: Partial<{ itemId: string; cluster: string; name: string; evidence: string; atSeconds: number }> = {}) => ({
    itemId: 'ep', cluster: 'SPEAKER_11', name: '多多', evidence: '大家好我是多多', atSeconds: 100, ...over,
  })

  it('enqueues a pending record and lists it (only pending status)', () => {
    const s = mk()
    expect(s.enqueuePendingName(rec())).toBe('pending')
    const list = s.listPendingNames('ep')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ itemId: 'ep', cluster: 'SPEAKER_11', name: '多多', evidence: '大家好我是多多', atSeconds: 100 })
    expect(s.getPendingName('ep', 'SPEAKER_11')?.name).toBe('多多')
    expect(s.listPendingNames('other')).toEqual([])
  })

  it('skips when a person with that name already exists (globally confirmed)', () => {
    const s = mk()
    s.createPerson('多多')
    expect(s.enqueuePendingName(rec())).toBe('skipped')
    expect(s.listPendingNames('ep')).toEqual([])
  })

  it('skips a name already rejected for the same work — even from a different cluster', () => {
    const s = mk()
    s.enqueuePendingName(rec())
    s.rejectPendingName('ep', 'SPEAKER_11')
    expect(s.listPendingNames('ep')).toEqual([]) // rejected 不再列
    // 另一被拆出的簇再抽到同名同作品 → 不再入队
    expect(s.enqueuePendingName(rec({ cluster: 'SPEAKER_05' }))).toBe('skipped')
    expect(s.listPendingNames('ep')).toEqual([])
  })

  it('dedupes: one pending per name per item even across split clusters', () => {
    const s = mk()
    expect(s.enqueuePendingName(rec({ cluster: 'SPEAKER_11' }))).toBe('pending')
    expect(s.enqueuePendingName(rec({ cluster: 'SPEAKER_05' }))).toBe('skipped')
    expect(s.listPendingNames('ep')).toHaveLength(1)
  })

  it('重跑聚类后，待确认要能挂到新的簇上——旧的 pending 行不许把它挡掉', () => {
    // 真实故障（喜剧之王 E02）：第一次跑，「徐不弃」挂在 SPEAKER_17；重跑聚类后簇号全变，
    // 他真正的发言成了 SPEAKER_70（346s），而 SPEAKER_17 只剩一句「是吗」（0s）。
    // 旧 pending 行没清，同名去重又按名字挡新行 → 名字永久钉在那个 0 秒的垃圾簇上。
    const s = mk()
    expect(s.enqueuePendingName(rec({ cluster: 'SPEAKER_17', name: '徐不弃' }))).toBe('pending')
    // 重跑：清掉本 item 的待确认，再按新簇号入队
    s.clearPendingNames('ep')
    expect(s.listPendingNames('ep')).toEqual([])
    expect(s.enqueuePendingName(rec({ cluster: 'SPEAKER_70', name: '徐不弃' }))).toBe('pending')
    expect(s.getPendingName('ep', 'SPEAKER_70')?.name).toBe('徐不弃')
  })

  it('clearPendingNames 只清 pending，不碰 rejected（用户说过不认的别再问）', () => {
    const s = mk()
    s.enqueuePendingName(rec({ cluster: 'SPEAKER_11', name: '多多' }))
    s.rejectPendingName('ep', 'SPEAKER_11')
    s.enqueuePendingName(rec({ cluster: 'SPEAKER_22', name: '徐不弃' }))
    s.clearPendingNames('ep')
    expect(s.listPendingNames('ep')).toEqual([])
    // rejected 仍在 → 同名再抽到照样不入队
    expect(s.enqueuePendingName(rec({ cluster: 'SPEAKER_33', name: '多多' }))).toBe('skipped')
    // 别的 item 不受影响
    s.enqueuePendingName(rec({ itemId: 'ep2', cluster: 'SPEAKER_01', name: '小鹿' }))
    s.clearPendingNames('ep')
    expect(s.listPendingNames('ep2')).toHaveLength(1)
  })

  it('deletePendingName removes the row (confirm path)', () => {
    const s = mk()
    s.enqueuePendingName(rec())
    s.deletePendingName('ep', 'SPEAKER_11')
    expect(s.listPendingNames('ep')).toEqual([])
  })

  it('a rejected name in one work does not block the same name in another work', () => {
    const s = mk()
    s.enqueuePendingName(rec())
    s.rejectPendingName('ep', 'SPEAKER_11')
    expect(s.enqueuePendingName(rec({ itemId: 'ep2' }))).toBe('pending')
  })
})

describe('appearances ledger', () => {
  const seg = (start: number, end: number, speaker?: string) => ({ start, end, text: 'x', speaker })

  it('recompute writes one row per matched person, skips anonymous clusters', () => {
    const s = mk()
    const a = s.createPerson('庞博')
    const b = s.createPerson('徐志胜')
    s.recomputeItemAppearances('ep1', [
      seg(0, 10, '庞博'),
      seg(10, 25, '徐志胜'),
      seg(25, 30, '庞博'),
      seg(30, 40, 'SPEAKER_07'), // anonymous — no person
      seg(40, 45, undefined), // no speaker — dropped
    ])
    const rows = s.listAppearancesForPersons([a.id, b.id], 0)
    const pang = rows.find((r) => r.personId === a.id)!
    const xu = rows.find((r) => r.personId === b.id)!
    expect(pang.seconds).toBe(15) // 10 + 5
    expect(pang.segments).toBe(2)
    expect(pang.firstAt).toBe(0)
    expect(pang.nameAtTime).toBe('庞博')
    expect(xu.seconds).toBe(15)
    expect(xu.segments).toBe(1)
    expect(rows).toHaveLength(2) // anonymous cluster produced no row
  })

  it('re-identify replaces an item ledger, never accumulates', () => {
    const s = mk()
    const a = s.createPerson('庞博')
    s.recomputeItemAppearances('ep1', [seg(0, 30, '庞博')])
    s.recomputeItemAppearances('ep1', [seg(0, 10, '庞博')]) // shorter second pass
    const rows = s.listAppearancesForPersons([a.id], 0)
    expect(rows).toHaveLength(1)
    expect(rows[0].seconds).toBe(10) // replaced, not 30 or 40
  })

  it('resolves speaker labels via alias', () => {
    const s = mk()
    const a = s.createPerson('庞博', ['Pang Bo'])
    s.recomputeItemAppearances('ep1', [seg(0, 12, 'Pang Bo')])
    const rows = s.listAppearancesForPersons([a.id], 0)
    expect(rows).toHaveLength(1)
    expect(rows[0].personId).toBe(a.id)
    expect(rows[0].seconds).toBe(12)
  })

  it('listAppearancesForPersons filters by minSeconds and sorts desc', () => {
    const s = mk()
    const a = s.createPerson('庞博')
    s.recomputeItemAppearances('ep1', [seg(0, 100, '庞博')])
    s.recomputeItemAppearances('ep2', [seg(0, 20, '庞博')])
    s.recomputeItemAppearances('ep3', [seg(0, 5, '庞博')])
    const rows = s.listAppearancesForPersons([a.id], 30)
    expect(rows.map((r) => r.itemId)).toEqual(['ep1']) // ep2/ep3 below 30s dropped
    const more = s.listAppearancesForPersons([a.id], 10)
    expect(more.map((r) => r.itemId)).toEqual(['ep1', 'ep2']) // desc
  })

  it('diarization timeline: put replaces wholesale, get returns time order', () => {
    const s = mk()
    s.putItemTimeline('ep1', [
      { start: 10, end: 20, speaker: 'SPEAKER_01' },
      { start: 0, end: 10, speaker: 'SPEAKER_00' },
    ])
    expect(s.getItemTimeline('ep1')).toEqual([
      { start: 0, end: 10, speaker: 'SPEAKER_00' },
      { start: 10, end: 20, speaker: 'SPEAKER_01' },
    ])
    // 重跑 identify = 整条时间线换掉，不是追加（簇号每次重排，混着就是两台机器的产物拼一起）
    s.putItemTimeline('ep1', [{ start: 0, end: 5, speaker: 'SPEAKER_00' }])
    expect(s.getItemTimeline('ep1')).toEqual([{ start: 0, end: 5, speaker: 'SPEAKER_00' }])
    expect(s.getItemTimeline('nope')).toEqual([])
  })

  it('diarization timeline: rename a cluster label in place, delete drops the item', () => {
    const s = mk()
    s.putItemTimeline('ep1', [
      { start: 0, end: 10, speaker: 'SPEAKER_00' },
      { start: 10, end: 20, speaker: 'SPEAKER_01' },
      { start: 20, end: 30, speaker: 'SPEAKER_00' },
    ])
    s.putItemTimeline('ep2', [{ start: 0, end: 10, speaker: 'SPEAKER_00' }])
    expect(s.renameInTimeline('ep1', 'SPEAKER_00', '庞博')).toBe(2)
    expect(s.getItemTimeline('ep1').map((x) => x.speaker)).toEqual(['庞博', 'SPEAKER_01', '庞博'])
    expect(s.getItemTimeline('ep2')[0].speaker).toBe('SPEAKER_00') // 只动这个 item
    s.deleteItemTimeline('ep1')
    expect(s.getItemTimeline('ep1')).toEqual([])
    expect(s.getItemTimeline('ep2')).toHaveLength(1)
  })

  it('findPersonsByName: exact wins, then alias, then substring, else empty', () => {
    const s = mk()
    const a = s.createPerson('庞博', ['Pang Bo'])
    s.createPerson('庞博的朋友') // substring superset — must NOT win over exact
    expect(s.findPersonsByName('庞博').map((p) => p.id)).toEqual([a.id]) // exact only
    expect(s.findPersonsByName('Pang Bo').map((p) => p.id)).toEqual([a.id]) // alias exact
    expect(s.findPersonsByName('朋友').map((p) => p.name)).toEqual(['庞博的朋友']) // substring fallback
    expect(s.findPersonsByName('王五')).toEqual([]) // no match
  })
})

describe('single-voiceprint maintenance', () => {
  it('lists a person 的声纹元数据（不吐 embedding 本体）', () => {
    const s = mk()
    const a = s.createPerson('A')
    const v1 = s.addVoiceprint(a.id, [1, 0], 'v1', 'ep1:SPEAKER_00')
    const v2 = s.addVoiceprint(a.id, [0, 1], 'v1', 'ep2:SPEAKER_03')
    const list = s.listVoiceprints(a.id)
    expect(list.map((v) => v.id).sort()).toEqual([v1.id, v2.id].sort())
    expect(list[0]).not.toHaveProperty('embedding')
    expect(list.map((v) => v.source).sort()).toEqual(['ep1:SPEAKER_00', 'ep2:SPEAKER_03'])
    expect(list.every((v) => v.modelVersion === 'v1' && v.enrolledAt && v.personId === a.id)).toBe(true)
  })

  it('deletes one voiceprint by id — 别人的 print 不受影响', () => {
    const s = mk()
    const a = s.createPerson('A')
    const b = s.createPerson('B')
    const bad = s.addVoiceprint(a.id, [1, 0], 'v1', '污染样本')
    const good = s.addVoiceprint(a.id, [0, 1], 'v1', '干净样本')
    const other = s.addVoiceprint(b.id, [1, 1], 'v1', 'b')
    expect(s.deleteVoiceprint(a.id, bad.id)).toBe(true)
    expect(s.listVoiceprints(a.id).map((v) => v.id)).toEqual([good.id])
    expect(s.listVoiceprints(b.id).map((v) => v.id)).toEqual([other.id])
  })

  it('deleteVoiceprint 拒绝跨 person 删（不属于该 person → false，且不删）', () => {
    const s = mk()
    const a = s.createPerson('A')
    const b = s.createPerson('B')
    const vb = s.addVoiceprint(b.id, [1, 1], 'v1', 'b')
    expect(s.deleteVoiceprint(a.id, vb.id)).toBe(false)
    expect(s.deleteVoiceprint(a.id, 'nope')).toBe(false)
    expect(s.listVoiceprints(b.id)).toHaveLength(1)
  })

  it('删到最后一条不级联删 person——人还在，只是匹配不到他', () => {
    const s = mk()
    const a = s.createPerson('A')
    const only = s.addVoiceprint(a.id, [1, 0], 'v1', 'ep1')
    expect(s.deleteVoiceprint(a.id, only.id)).toBe(true)
    expect(s.getPerson(a.id)?.name).toBe('A')
    expect(s.listVoiceprints(a.id)).toEqual([])
    expect(s.match([1, 0], 'v1')).toEqual([]) // 无声纹的人不参与匹配，也不炸
  })
})

describe('person 删除的账清理', () => {
  it('deleteAppearancesForPerson 只清这个人的账', () => {
    const s = mk()
    const a = s.createPerson('A')
    const b = s.createPerson('B')
    s.recomputeItemAppearances('ep1', [
      { start: 0, end: 100, speaker: 'A' },
      { start: 100, end: 200, speaker: 'B' },
    ])
    s.deleteAppearancesForPerson(a.id)
    expect(s.listAppearancesForPersons([a.id], 0)).toEqual([])
    expect(s.listAppearancesForPersons([b.id], 0)).toHaveLength(1)
  })

  it('listItemClusterNames 列出该 item 现存的簇号', () => {
    const s = mk()
    s.putItemCluster('ep1', 'SPEAKER_00', [1, 0], 'v1')
    s.putItemCluster('ep1', 'SPEAKER_07', [0, 1], 'v1')
    s.putItemCluster('ep2', 'SPEAKER_00', [1, 1], 'v1')
    expect(s.listItemClusterNames('ep1').sort()).toEqual(['SPEAKER_00', 'SPEAKER_07'])
  })
})
