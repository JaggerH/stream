// 从 app.test.ts 拆出(2026-07-22):按路由域分文件,理由见 __fixtures__/app-harness.ts 头注。

import { describe, it, expect } from 'vitest'
import { createHttpApp, type HealthInfo } from './app.ts'
import { SpeakerRegistryStore } from '../voiceprint/store.ts'
import { ConversionStore } from '../conversions/store.ts'
import { ConversionRunner } from '../conversions/runner.ts'
import { makeIdentifyConverter } from '../conversions/converters/identify.ts'
import { makeIdentifyFn } from '../voiceprint/identify.ts'
import { health, item, manifests } from './__fixtures__/app-harness.ts'

describe('voiceprint routes', () => {
  const baseStubs = {
    service: { streamsResource: () => [] },
    itemStore: { get: () => undefined },
    health: async () => ({ cookies: { domains: [], updatedAt: null }, manifests: 0, streams: 0 }),
  } as never

  // Local test harness (the task brief assumed a project-wide makeApp() factory that doesn't
  // exist in this file — every other describe block here builds createHttpApp inline with its
  // own stubs, so this mirrors that convention instead). Wires a real in-memory
  // SpeakerRegistryStore + a real ConversionStore/ConversionRunner: 声纹这几条路由现在就是从
  // runner 读写转写 segments 的，所以测试也走真身，不再自造一个 transcript 替身。
  function makeApp(over: { run?: () => Promise<{ ok: true; result: unknown }> } = {}) {
    const speakerRegistry = new SpeakerRegistryStore(':memory:')
    const store = new ConversionStore(':memory:')
    const conversions = new ConversionRunner({
      store,
      // identify 可用 = 「补说话人」那条路由的 503 门开着；跑起来什么都不做（这些用例不验它的产物）。
      converters: [
        {
          kind: 'identify', label: '补说话人', stages: [], available: () => true,
          run: over.run ?? (async () => ({ ok: true, result: {} })),
        },
      ],
      derivations: [], costarts: [],
    })
    /** 造一条已完成的转写 = 一条走了 stt 分支的 extract。调用方仍按老形状递
     *  `{text, lang, segments}`，这里替它折进 extract 的形状——测试要守的是路由行为，
     *  不该被产物形状的搬家占满。 */
    const putTranscript = (itemId: string, result: Record<string, unknown>) => {
      const { text, ...rest } = result as { text?: string }
      const rec = store.create({ kind: 'extract', itemId })
      store.update(rec.id, {
        status: 'done',
        result: { text: text ?? '', format: 'plain', branch: 'stt', detail: rest },
      })
      return rec
    }
    /** 读回该 item 转写的产物（断言用）——摊回老形状，断言照旧读 segments/lang。 */
    const transcriptOf = (itemId: string) => {
      const r = conversions.transcriptOf(itemId)?.result as
        | { text?: string; detail?: { lang?: string; segments?: Array<{ start: number; end: number; text: string; speaker?: string }> } }
        | undefined
      return r ? { text: r.text, ...(r.detail ?? {}) } : undefined
    }
    const app = createHttpApp({ ...(baseStubs as object), speakerRegistry, conversions } as never)
    return { app, speakerRegistry, conversions, putTranscript, transcriptOf }
  }

  it('POST /clusters 不再以转写为前提——没有任何转写也排得上队（识别 = 纯 diarization）', async () => {
    const { app, speakerRegistry, conversions } = makeApp()
    try {
      const r = await app.request('/api/voiceprint/item/item1/clusters', { method: 'POST' })
      expect(r.status).toBe(202)
      expect(conversions.list({ item: 'item1', kind: 'identify' }).items).toHaveLength(1)
    } finally {
      speakerRegistry.close()
    }
  })

  it('POST /clusters 仍拒绝并发（该 item 已有在跑的活儿）', async () => {
    const { app, speakerRegistry, conversions } = makeApp({ run: () => new Promise(() => {}) as never })
    try {
      conversions.start('identify', 'item1', { force: true })
      const busy = await app.request('/api/voiceprint/item/item1/clusters', { method: 'POST' })
      expect(busy.status).toBe(409)
    } finally {
      speakerRegistry.close()
    }
  })

  it('GET /clusters 与 /blocks 读 diarization 时间线（无转写也有簇有块）', async () => {
    const { app, speakerRegistry } = makeApp()
    try {
      speakerRegistry.putItemTimeline('item1', [
        { start: 0, end: 40, speaker: 'SPEAKER_00' },
        { start: 40, end: 90, speaker: 'SPEAKER_00' },
        { start: 90, end: 100, speaker: 'SPEAKER_01' },
      ])
      const clusters = (await (await app.request('/api/voiceprint/item/item1/clusters')).json()).clusters
      expect(clusters.find((c: { cluster: string }) => c.cluster === 'SPEAKER_00').seconds).toBe(90)
      expect(clusters.find((c: { cluster: string }) => c.cluster === 'SPEAKER_01').seconds).toBe(10)
      const blocks = (await (await app.request('/api/voiceprint/item/item1/blocks')).json()).blocks
      expect(blocks).toEqual([{ start: 0, end: 90, label: 'SPEAKER_00' }])
    } finally {
      speakerRegistry.close()
    }
  })

  it('GET /blocks 不再回退读转写抄件——时间线是唯一数据源（存量靠启动迁移反推）', async () => {
    const { app, speakerRegistry, putTranscript } = makeApp()
    try {
      // 抄件里有名字、时间线为空：这个状态只该出现在启动迁移（migrate-segments.ts）跑过之前。
      // 读口对它的正确答案是「没有说话人数据」——静默用抄件会让已删的人复活。
      putTranscript('legacy', {
        segments: [{ start: 0, end: 40, text: 'a', speaker: '庞博' }],
      })
      expect(speakerRegistry.getItemTimeline('legacy')).toEqual([])
      const blocks = (await (await app.request('/api/voiceprint/item/legacy/blocks')).json()).blocks
      expect(blocks).toEqual([])
      const clusters = (await (await app.request('/api/voiceprint/item/legacy/clusters')).json()).clusters
      expect(clusters).toEqual([])
    } finally {
      speakerRegistry.close()
    }
  })

  it('enroll 只写时间线：转写记录原样不动（段上的名字是读时现算的投影）', async () => {
    const { app, speakerRegistry, putTranscript, transcriptOf } = makeApp()
    try {
      const p = speakerRegistry.createPerson('庞博')
      speakerRegistry.putItemCluster('item1', 'SPEAKER_00', [1, 0], 'v1')
      speakerRegistry.putItemTimeline('item1', [
        { start: 0, end: 80, speaker: 'SPEAKER_00' },
        { start: 80, end: 90, speaker: 'SPEAKER_01' },
      ])
      putTranscript('item1', { text: 't', lang: 'zh', segments: [{ start: 0, end: 80, text: 'a', speaker: 'SPEAKER_00' }] })
      const res = await app.request('/api/voiceprint/item/item1/clusters/SPEAKER_00/enroll', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ personId: p.id }),
      })
      expect(res.status).toBe(200)
      expect(speakerRegistry.getItemTimeline('item1').map((s) => s.speaker)).toEqual(['庞博', 'SPEAKER_01'])
      // 存储的转写记录一个字都不动——名字只活在时间线上
      expect(transcriptOf('item1')?.segments?.[0].speaker).toBe('SPEAKER_00')
      expect(transcriptOf('item1')?.text).toBe('t')
      expect(transcriptOf('item1')?.lang).toBe('zh')
    } finally {
      speakerRegistry.close()
    }
  })

  it('enroll 无转写时也认得下来：时间线改名 + 出现账按时间线记', async () => {
    const { app, speakerRegistry } = makeApp()
    try {
      const p = speakerRegistry.createPerson('庞博')
      speakerRegistry.putItemCluster('item1', 'SPEAKER_00', [1, 0], 'v1')
      speakerRegistry.putItemTimeline('item1', [{ start: 0, end: 80, speaker: 'SPEAKER_00' }])
      const res = await app.request('/api/voiceprint/item/item1/clusters/SPEAKER_00/enroll', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ personId: p.id }),
      })
      expect(res.status).toBe(200)
      expect(speakerRegistry.getItemTimeline('item1')[0].speaker).toBe('庞博')
      const rows = speakerRegistry.listAppearancesForPersons([p.id], 0)
      expect(rows.map((r) => r.seconds)).toEqual([80])
    } finally {
      speakerRegistry.close()
    }
  })

  // 全链路（注入 fake engine，不碰真容器）：一个**从未转写过**的 item，POST /clusters 排队 →
  // identify 跑纯 diarization → 时间线落库 → /clusters 有簇、/blocks 有块。这条就是「死按钮」的验收。
  it('无转写全链路：POST /clusters → 纯 diarization → /clusters 有簇、/blocks 有块', async () => {
    const speakerRegistry = new SpeakerRegistryStore(':memory:')
    const store = new ConversionStore(':memory:')
    const engine = {
      configured: () => true,
      diarize: async () => ({
        modelVersion: 'v1',
        segments: [
          { start: 0, end: 90, speaker: 'SPEAKER_00', embedding: [1, 0] },
          { start: 90, end: 100, speaker: 'SPEAKER_01', embedding: [0, 1] },
        ],
      }),
    } as never
    const conversions = new ConversionRunner({
      store,
      converters: [
        makeIdentifyConverter({
          store,
          available: () => true,
          resolveMedia: async () => ({ bytes: new Uint8Array([1]), mime: 'audio/wav' }),
          identify: makeIdentifyFn({ engine, registry: speakerRegistry }),
          readTimeline: (itemId) => speakerRegistry.getItemTimeline(itemId),
          recordAppearances: (itemId) => speakerRegistry.recomputeItemAppearances(itemId, speakerRegistry.getItemTimeline(itemId)),
        }),
      ],
      derivations: [], costarts: [],
    })
    const app = createHttpApp({ ...(baseStubs as object), speakerRegistry, conversions } as never)
    try {
      expect(conversions.transcriptOf('fresh')).toBeNull() // 从未转写过
      const posted = await app.request('/api/voiceprint/item/fresh/clusters', { method: 'POST' })
      expect(posted.status).toBe(202)
      await new Promise((r) => setTimeout(r, 10))

      const clusters = (await (await app.request('/api/voiceprint/item/fresh/clusters')).json()).clusters
      expect(clusters.find((c: { cluster: string }) => c.cluster === 'SPEAKER_00').seconds).toBe(90)
      const blocks = (await (await app.request('/api/voiceprint/item/fresh/blocks')).json()).blocks
      expect(blocks).toEqual([{ start: 0, end: 90, label: 'SPEAKER_00' }])
    } finally {
      speakerRegistry.close()
    }
  })

  it('creates, lists, deletes a person', async () => {
    const { app, speakerRegistry } = makeApp()
    try {
      const created = await app.request('/api/voiceprint/persons', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '庞博' }),
      })
      expect(created.status).toBe(201)
      const person = await created.json()
      expect(person.name).toBe('庞博')
      const list = await (await app.request('/api/voiceprint/persons')).json()
      expect(list.persons).toHaveLength(1)
      const del = await app.request(`/api/voiceprint/persons/${person.id}`, { method: 'DELETE' })
      expect(del.status).toBe(204)
      expect((await (await app.request('/api/voiceprint/persons')).json()).persons).toHaveLength(0)
    } finally {
      speakerRegistry.close()
    }
  })

  it('enroll adds a voiceprint and renames the cluster in the timeline', async () => {
    const { app, speakerRegistry } = makeApp()
    try {
      const p = speakerRegistry.createPerson('庞博')
      speakerRegistry.putItemCluster('item1', 'SPEAKER_00', [1, 0], 'v1')
      speakerRegistry.putItemTimeline('item1', [{ start: 0, end: 40, speaker: 'SPEAKER_00' }])
      const res = await app.request('/api/voiceprint/item/item1/clusters/SPEAKER_00/enroll', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ personId: p.id }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(speakerRegistry.getItemTimeline('item1')[0].speaker).toBe('庞博')
      expect(speakerRegistry.match([1, 0], 'v1')[0].personId).toBe(p.id)
    } finally {
      speakerRegistry.close()
    }
  })

  it('enroll 404s for an unknown person or an unknown cluster', async () => {
    const { app, putTranscript, transcriptOf, speakerRegistry } = makeApp()
    try {
      speakerRegistry.putItemCluster('item1', 'SPEAKER_00', [1, 0], 'v1')
      putTranscript('item1', { segments: [] })
      const badPerson = await app.request('/api/voiceprint/item/item1/clusters/SPEAKER_00/enroll', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ personId: 'nope' }),
      })
      expect(badPerson.status).toBe(404)

      const p = speakerRegistry.createPerson('庞博')
      const badCluster = await app.request('/api/voiceprint/item/item1/clusters/SPEAKER_99/enroll', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ personId: p.id }),
      })
      expect(badCluster.status).toBe(404)
    } finally {
      speakerRegistry.close()
    }
  })

  it('GET /blocks returns only the given person\'s >=60s merged blocks', async () => {
    const { app, speakerRegistry } = makeApp()
    try {
      speakerRegistry.putItemTimeline('item1', [
        // 庞博: 0-70 (contiguous, 70s) — qualifies (>=60s)
        { start: 0, end: 40, speaker: '庞博' },
        { start: 40, end: 70, speaker: '庞博' },
        // 思文: 70-90 (20s) — too short, dropped by threshold
        { start: 70, end: 90, speaker: '思文' },
        // 庞博 again but isolated by a gap > 8s from the first block — separate short block
        { start: 120, end: 130, speaker: '庞博' },
      ])
      const r = await (await app.request('/api/voiceprint/item/item1/blocks?person=%E5%BA%9E%E5%8D%9A')).json()
      expect(r.blocks).toEqual([{ start: 0, end: 70, label: '庞博' }])

      // unfiltered: only blocks that clear the 60s threshold, across all speakers
      const all = await (await app.request('/api/voiceprint/item/item1/blocks')).json()
      expect(all.blocks).toEqual([{ start: 0, end: 70, label: '庞博' }])
    } finally {
      speakerRegistry.close()
    }
  })

  it('GET /blocks honors minSeconds (default 60, override raises the floor)', async () => {
    const { app, speakerRegistry } = makeApp()
    try {
      // one 90s block for 庞博 — passes at 60, filtered out at 120
      speakerRegistry.putItemTimeline('ep1', Array.from({ length: 90 }, (_, t) => ({ start: t, end: t + 1, speaker: '庞博' })))
      const at60 = await (await app.request('/api/voiceprint/item/ep1/blocks')).json()
      expect(at60.blocks).toHaveLength(1)
      const at120 = await (await app.request('/api/voiceprint/item/ep1/blocks?minSeconds=120')).json()
      expect(at120.blocks).toHaveLength(0)
    } finally {
      speakerRegistry.close()
    }
  })

  it('GET /blocks 503s when transcribe is not configured', async () => {
    const app = createHttpApp({ ...(baseStubs as object) } as never)
    const r = await app.request('/api/voiceprint/item/item1/blocks')
    expect(r.status).toBe(503)
  })

  it('GET /clusters surfaces a pending intro name on its cluster', async () => {
    const { app, speakerRegistry } = makeApp()
    try {
      speakerRegistry.putItemTimeline('item1', [{ start: 0, end: 90, speaker: 'SPEAKER_00' }])
      speakerRegistry.enqueuePendingName({ itemId: 'item1', cluster: 'SPEAKER_00', name: '多多', evidence: '大家好我是多多', atSeconds: 0 })
      const r = await (await app.request('/api/voiceprint/item/item1/clusters')).json()
      const s0 = r.clusters.find((c: { cluster: string }) => c.cluster === 'SPEAKER_00')
      expect(s0.pending).toEqual({ name: '多多', evidence: '大家好我是多多' })
    } finally {
      speakerRegistry.close()
    }
  })

  it('enroll clears the cluster pending intro name (confirm path)', async () => {
    const { app, putTranscript, transcriptOf, speakerRegistry } = makeApp()
    try {
      const p = speakerRegistry.createPerson('多多')
      speakerRegistry.putItemCluster('item1', 'SPEAKER_00', [1, 0], 'v1')
      speakerRegistry.enqueuePendingName({ itemId: 'item1', cluster: 'SPEAKER_00', name: '多多', evidence: '大家好我是多多', atSeconds: 0 })
      putTranscript('item1', { segments: [{ start: 0, end: 40, text: 'a', speaker: 'SPEAKER_00' }] })
      const res = await app.request('/api/voiceprint/item/item1/clusters/SPEAKER_00/enroll', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ personId: p.id }),
      })
      expect(res.status).toBe(200)
      expect(speakerRegistry.listPendingNames('item1')).toEqual([])
    } finally {
      speakerRegistry.close()
    }
  })

  it('DELETE /pending/:cluster records a rejection — the same name is not re-enqueued for this work', async () => {
    const { app, speakerRegistry } = makeApp()
    try {
      speakerRegistry.enqueuePendingName({ itemId: 'item1', cluster: 'SPEAKER_00', name: '多多', evidence: 'e', atSeconds: 0 })
      const res = await app.request('/api/voiceprint/item/item1/pending/SPEAKER_00', { method: 'DELETE' })
      expect(res.status).toBe(204)
      expect(speakerRegistry.listPendingNames('item1')).toEqual([])
      // 同名同作品再抽到(哪怕另一被拆出的簇) → 不再入队
      expect(speakerRegistry.enqueuePendingName({ itemId: 'item1', cluster: 'SPEAKER_09', name: '多多', evidence: 'e', atSeconds: 0 })).toBe('skipped')
      expect(speakerRegistry.listPendingNames('item1')).toEqual([])
    } finally {
      speakerRegistry.close()
    }
  })

  it('DELETE /pending/:cluster 503s when speakerRegistry is not configured', async () => {
    const app = createHttpApp({ ...(baseStubs as object) } as never)
    const r = await app.request('/api/voiceprint/item/item1/pending/SPEAKER_00', { method: 'DELETE' })
    expect(r.status).toBe(503)
  })

  it('every voiceprint route 503s when speakerRegistry is not configured', async () => {
    const app = createHttpApp({ ...(baseStubs as object) } as never)
    const list = await app.request('/api/voiceprint/persons')
    expect(list.status).toBe(503)
    expect((await list.json()).error.code).toBe('unavailable')

    const create = await app.request('/api/voiceprint/persons', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }),
    })
    expect(create.status).toBe(503)

    const del = await app.request('/api/voiceprint/persons/abc', { method: 'DELETE' })
    expect(del.status).toBe(503)

    const clusters = await app.request('/api/voiceprint/item/item1/clusters')
    expect(clusters.status).toBe(503)

    const enroll = await app.request('/api/voiceprint/item/item1/clusters/SPEAKER_00/enroll', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ personId: 'x' }),
    })
    expect(enroll.status).toBe(503)

    const vps = await app.request('/api/voiceprint/persons/abc/voiceprints')
    expect(vps.status).toBe(503)
    const delVp = await app.request('/api/voiceprint/persons/abc/voiceprints/xyz', { method: 'DELETE' })
    expect(delVp.status).toBe(503)

    const appearances = await app.request('/api/voiceprint/appearances?person=x')
    expect(appearances.status).toBe(503)
    const backfill = await app.request('/api/voiceprint/appearances/backfill', { method: 'POST' })
    expect(backfill.status).toBe(503)
  })

  it('GET /appearances queries the ledger by person name, filtered + sorted', async () => {
    const { app, putTranscript, transcriptOf, speakerRegistry } = makeApp()
    try {
      const p = speakerRegistry.createPerson('庞博')
      putTranscript('ep1', { segments: [{ start: 0, end: 100, text: 'a', speaker: '庞博' }] })
      putTranscript('ep2', { segments: [{ start: 0, end: 40, text: 'b', speaker: '庞博' }] })
      putTranscript('ep3', { segments: [{ start: 0, end: 5, text: 'c', speaker: '庞博' }] })
      speakerRegistry.recomputeItemAppearances('ep1', transcriptOf('ep1')!.segments!)
      speakerRegistry.recomputeItemAppearances('ep2', transcriptOf('ep2')!.segments!)
      speakerRegistry.recomputeItemAppearances('ep3', transcriptOf('ep3')!.segments!) // 5s < 30 default → dropped
      const r = await (await app.request('/api/voiceprint/appearances?person=庞博')).json()
      expect(r.appearances.map((a: { itemId: string }) => a.itemId)).toEqual(['ep1', 'ep2'])
      expect(r.appearances[0].seconds).toBe(100)
      expect(r.appearances[0].nameAtTime).toBe('庞博')
      // 400 without person; validation
      expect((await app.request('/api/voiceprint/appearances')).status).toBe(400)
      // unknown person → empty, not error
      const none = await (await app.request('/api/voiceprint/appearances?person=王五')).json()
      expect(none.appearances).toEqual([])
      void p
    } finally {
      speakerRegistry.close()
    }
  })

  it('POST /appearances/backfill scans stored transcripts and fills the ledger (no diarize)', async () => {
    const { app, putTranscript, transcriptOf, speakerRegistry } = makeApp()
    try {
      speakerRegistry.createPerson('庞博')
      putTranscript('ep1', { segments: [{ start: 0, end: 50, text: 'a', speaker: '庞博' }] })
      /* 'error' 状态的转写:allTranscripts 只取 done,所以它天然被跳过 */ // skipped (not done)
      const r = await app.request('/api/voiceprint/appearances/backfill', { method: 'POST' })
      expect(r.status).toBe(200)
      expect((await r.json()).items).toBe(1)
      const q = await (await app.request('/api/voiceprint/appearances?person=庞博')).json()
      expect(q.appearances).toHaveLength(1)
      expect(q.appearances[0].itemId).toBe('ep1')
      expect(q.appearances[0].seconds).toBe(50)
    } finally {
      speakerRegistry.close()
    }
  })

  it('enroll writes an appearance row for the item (归名那一刻)', async () => {
    const { app, speakerRegistry } = makeApp()
    try {
      const p = speakerRegistry.createPerson('庞博')
      speakerRegistry.putItemCluster('item1', 'SPEAKER_00', [1, 0], 'v1')
      speakerRegistry.putItemTimeline('item1', [{ start: 0, end: 80, speaker: 'SPEAKER_00' }])
      await app.request('/api/voiceprint/item/item1/clusters/SPEAKER_00/enroll', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ personId: p.id }),
      })
      const rows = speakerRegistry.listAppearancesForPersons([p.id], 0)
      expect(rows).toHaveLength(1)
      expect(rows[0].itemId).toBe('item1')
      expect(rows[0].seconds).toBe(80)
    } finally {
      speakerRegistry.close()
    }
  })

  // —— 单删一条声纹（一次 enroll 进了污染样本，不必整人删再全部重登） ——

  it('GET /persons/:id/voiceprints 列元数据，DELETE 单删一条', async () => {
    const { app, speakerRegistry } = makeApp()
    try {
      const p = speakerRegistry.createPerson('庞博')
      const bad = speakerRegistry.addVoiceprint(p.id, [1, 0], 'v1', 'ep1:SPEAKER_09')
      const good = speakerRegistry.addVoiceprint(p.id, [0, 1], 'v1', 'ep2:SPEAKER_00')

      const listed = await app.request(`/api/voiceprint/persons/${p.id}/voiceprints`)
      expect(listed.status).toBe(200)
      const body = await listed.json()
      expect(body.voiceprints.map((v: { id: string }) => v.id).sort()).toEqual([bad.id, good.id].sort())
      expect(body.voiceprints[0].embedding).toBeUndefined()
      expect(body.voiceprints.map((v: { source: string }) => v.source)).toContain('ep1:SPEAKER_09')

      const del = await app.request(`/api/voiceprint/persons/${p.id}/voiceprints/${bad.id}`, { method: 'DELETE' })
      expect(del.status).toBe(204)
      expect(speakerRegistry.listVoiceprints(p.id).map((v) => v.id)).toEqual([good.id])
      // 人还在——删声纹不级联删 person
      expect(speakerRegistry.getPerson(p.id)?.name).toBe('庞博')
    } finally {
      speakerRegistry.close()
    }
  })

  it('声纹路由 404：人不存在 / 声纹不存在 / 声纹不属于该人', async () => {
    const { app, speakerRegistry } = makeApp()
    try {
      const a = speakerRegistry.createPerson('A')
      const b = speakerRegistry.createPerson('B')
      const vb = speakerRegistry.addVoiceprint(b.id, [1, 1], 'v1', 'ep1:SPEAKER_00')

      expect((await app.request('/api/voiceprint/persons/nope/voiceprints')).status).toBe(404)
      const delUnknownPerson = await app.request(`/api/voiceprint/persons/nope/voiceprints/${vb.id}`, { method: 'DELETE' })
      expect(delUnknownPerson.status).toBe(404)
      expect((await delUnknownPerson.json()).error.code).toBe('not_found')
      // 归属错人 → 也是 404，且不许把 B 的 print 删掉
      const crossPerson = await app.request(`/api/voiceprint/persons/${a.id}/voiceprints/${vb.id}`, { method: 'DELETE' })
      expect(crossPerson.status).toBe(404)
      expect(speakerRegistry.listVoiceprints(b.id)).toHaveLength(1)
      expect((await app.request(`/api/voiceprint/persons/${a.id}/voiceprints/ghost`, { method: 'DELETE' })).status).toBe(404)
    } finally {
      speakerRegistry.close()
    }
  })

  // —— 删 person 撤回已写进时间线的名字字面量 ——

  it('DELETE /persons/:id 把名字从时间线里撤回原簇号，并清掉出现账', async () => {
    const { app, speakerRegistry } = makeApp()
    try {
      const p = speakerRegistry.createPerson('庞博')
      speakerRegistry.putItemCluster('item1', 'SPEAKER_00', [1, 0], 'v1')
      speakerRegistry.putItemTimeline('item1', [
        { start: 0, end: 80, speaker: 'SPEAKER_00' },
        { start: 80, end: 200, speaker: 'SPEAKER_01' },
      ])
      await app.request('/api/voiceprint/item/item1/clusters/SPEAKER_00/enroll', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ personId: p.id }),
      })
      expect(speakerRegistry.getItemTimeline('item1')[0].speaker).toBe('庞博')
      expect(speakerRegistry.listAppearancesForPersons([p.id], 0)).toHaveLength(1)

      const del = await app.request(`/api/voiceprint/persons/${p.id}`, { method: 'DELETE' })
      expect(del.status).toBe(204)

      // 反向映射（voiceprint.source → item_clusters）拿回原簇号
      expect(speakerRegistry.getItemTimeline('item1').map((s) => s.speaker)).toEqual(['SPEAKER_00', 'SPEAKER_01'])
      expect(speakerRegistry.listAppearancesForPersons([p.id], 0)).toEqual([])
      expect(speakerRegistry.getPerson(p.id)).toBeNull()
      // /clusters 不再把人名当簇渲染
      const clusters = await (await app.request('/api/voiceprint/item/item1/clusters')).json()
      expect(clusters.clusters.map((c: { cluster: string }) => c.cluster).sort()).toEqual(['SPEAKER_00', 'SPEAKER_01'])
    } finally {
      speakerRegistry.close()
    }
  })

  it('DELETE /persons/:id 撤不回原簇号时用顺延匿名标签（自动认名、无声纹来源）', async () => {
    const { app, speakerRegistry } = makeApp()
    try {
      const p = speakerRegistry.createPerson('庞博')
      // identify 自动归名的形状：标签已是人名，但这个 item 上没有 enroll 留下的声纹来源
      speakerRegistry.putItemTimeline('item9', [
        { start: 0, end: 80, speaker: '庞博' },
        { start: 80, end: 200, speaker: 'SPEAKER_04' },
      ])
      speakerRegistry.recomputeItemAppearances('item9', [{ start: 0, end: 80, speaker: '庞博' }])

      expect((await app.request(`/api/voiceprint/persons/${p.id}`, { method: 'DELETE' })).status).toBe(204)

      expect(speakerRegistry.getItemTimeline('item9').map((s) => s.speaker)).toEqual(['SPEAKER_05', 'SPEAKER_04'])
      expect(speakerRegistry.listAppearancesForPersons([p.id], 0)).toEqual([])
    } finally {
      speakerRegistry.close()
    }
  })
})
