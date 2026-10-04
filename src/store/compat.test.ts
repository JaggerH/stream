import { describe, it, expect } from 'vitest'
import { streamRecordToStream, streamToStreamRecord } from './compat.ts'
import type { Stream } from '../streams/types.ts'
import type { StreamRecord } from './types.ts'

describe('compat bridge', () => {
  const ns: Stream = {
    id: 'pod',
    description: '某播客',
    sources: [
      { plugin_id: 'rsshub', source_template_id: 'xiaoyuzhou/podcast', params: { id: '1' } },
      { plugin_id: 'rsshub', source_template_id: 'mirror/podcast', params: { id: '1' } },
    ],
    cadence_seconds: 3600,
    vault_subdir: 'pod',
    strategy: 'exclusive',
    ad_filter: { keywords: ['广告'] },
  }

  it('round-trips scheduler-relevant fields', () => {
    const back = streamRecordToStream(streamToStreamRecord(ns))
    expect(back).toEqual(ns)
  })

  it('passes strategy through untranslated, defaulting absent to fanout', () => {
    const rec = streamToStreamRecord(ns)
    expect(rec.strategy).toBe('exclusive')
    expect(streamRecordToStream(rec).strategy).toBe('exclusive')
    const fan = streamToStreamRecord({ ...ns, strategy: undefined })
    expect(fan.strategy).toBe('fanout')
    expect(streamRecordToStream(fan).strategy).toBe('fanout')
  })

  it('defaults vault_subdir to the stream id when options lack it', () => {
    const back = streamRecordToStream({
      id: 'x', label: 'X', strategy: 'fanout', cadence_seconds: 60, members: [], options: {},
    })
    expect(back.vault_subdir).toBe('x')
  })

  // The legacy ordering/kind → mode translation is retired (the live DB has zero rows carrying
  // either; the boot migration that scrubbed them ran on every start since 2026-07-19). `mode` is
  // now read straight through, and a stream without one resolves live via scheduler.modeOf().
  it('reads mode straight through and ignores retired legacy keys', () => {
    const base = { id: 'x', label: 'X', strategy: 'fanout' as const, cadence_seconds: 60, members: [] }
    expect(streamRecordToStream({ ...base, options: { ordering: 'snapshot' } }).mode).toBeUndefined()
    expect(streamRecordToStream({ ...base, options: { kind: 'audio' } }).mode).toBeUndefined()
    expect(streamRecordToStream({ ...base, options: {} }).mode).toBeUndefined()
  })

  // labelAuto 是「这个名字只是占位、首采后改成真名」的开关（auto-name.ts 消费它）。桥要双向
  // 通：只映射一边的后果是安静的——要么这条路建的流永远拿不到自动命名（名字停在调用方编的
  // 那句话上），要么改完名再读回来又变回"待改名"，下次采集把用户改的名字盖掉。
  it('两个方向都带上 label_auto，且没有这一格时不凭空造出来', () => {
    const rec = streamToStreamRecord({ ...ns, label_auto: true })
    expect((rec.options as Record<string, unknown>).labelAuto).toBe(true)
    expect(streamRecordToStream(rec).label_auto).toBe(true)

    const plain = streamToStreamRecord(ns)
    expect((plain.options as Record<string, unknown>).labelAuto).toBeUndefined()
    expect(streamRecordToStream(plain).label_auto).toBeUndefined()
  })

  it('forwards an explicit mode through the bridge', () => {
    const rec = streamToStreamRecord({ ...ns, mode: 'collection' })
    expect((rec.options as Record<string, unknown>).mode).toBe('collection')
    expect(streamRecordToStream(rec).mode).toBe('collection')
  })
})

describe('streamRecordToStream / streamToStreamRecord — season passthrough', () => {
  const record: StreamRecord = {
    id: 'show-1',
    label: '喜剧之王单口季',
    strategy: 'fanout',
    cadence_seconds: 3600,
    members: [
      { plugin: 'rsshub', source: 'iqiyi/cn/album/:id', params: { id: 'season1-album' }, season: 1 },
      { plugin: 'rsshub', source: 'iqiyi/cn/album/:id', params: { id: 'season3-album' }, season: 3 },
    ],
    options: {},
  }

  it('carries season from persisted SourceBinding into runtime StreamMember', () => {
    const stream = streamRecordToStream(record)
    expect(stream.sources.map((s) => s.season)).toEqual([1, 3])
  })

  it('carries season back from runtime StreamMember into persisted SourceBinding', () => {
    const stream = streamRecordToStream(record)
    const roundTripped = streamToStreamRecord(stream)
    expect(roundTripped.members.map((m) => m.season)).toEqual([1, 3])
  })

  it('leaves season undefined for a member that never had one (old streams unaffected)', () => {
    const noSeason: StreamRecord = { ...record, members: [{ plugin: 'rsshub', source: 'x', params: {} }] }
    const stream = streamRecordToStream(noSeason)
    expect(stream.sources[0].season).toBeUndefined()
    expect(streamToStreamRecord(stream).members[0].season).toBeUndefined()
  })
})
