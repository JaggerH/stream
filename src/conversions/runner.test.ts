import { describe, expect, it, vi } from 'vitest'
import { ConversionStore } from './store.ts'
import { ConversionRunner, type Converter } from './runner.ts'
import { LadderError } from '../providers/ladder-trace.ts'
import type { DerivationRule, CostartRule } from './derive.ts'

/** A converter whose run() is fully controlled by the test. */
function makeConverter(over: Partial<Converter> = {}): Converter {
  return {
    kind: 'extract',
    label: '转成文字',
    stages: ['fetch', 'ocr'],
    available: () => true,
    async run(ctx) {
      const md = await ctx.stage('ocr', async () => '# hi')
      return { ok: true, result: { markdown: md } }
    },
    ...over,
  }
}

function setup(
  converters: Converter[],
  opts: {
    now?: () => number
    schedule?: (fn: () => void, ms: number) => void
    derivations?: readonly DerivationRule[]
    costarts?: readonly CostartRule[]
    maxConcurrent?: number
  } = {}
) {
  const store = new ConversionStore(':memory:')
  const runner = new ConversionRunner({
    store,
    converters,
    now: opts.now,
    schedule: opts.schedule,
    derivations: opts.derivations ?? [],
    costarts: opts.costarts ?? [],
    maxConcurrent: opts.maxConcurrent,
  })
  return { store, runner }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

/** 跑 fn 期间收集所有 unhandledRejection——用来验证「派生失败不能穿透变成裸奔的 rejection」。
 *  `deriveFrom` 不 await 任何东西，它引发的 unhandled rejection 只会在事件循环转一圈之后才
 *  触发进程事件，所以调用方跑完 fn 后还要再等一轮 settle 才能收全。 */
async function withUnhandledCapture(fn: () => Promise<void>): Promise<Error[]> {
  const caught: Error[] = []
  const onUnhandled = (err: unknown) => { caught.push(err as Error) }
  process.on('unhandledRejection', onUnhandled)
  try {
    await fn()
    await settle()
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  return caught
}

describe('ConversionRunner', () => {
  it('runs a conversion to done and stores the converter result', async () => {
    const { runner } = setup([makeConverter()])
    const { record, created } = runner.start('extract', 'item-1', {})
    expect(created).toBe(true)
    // pump() 是同步的：有空槽时 start() 返回的已经是 running（与重构前两个 service 一致）
    expect(record.status).toBe('running')
    await settle()
    const done = runner.get(record.id)!
    expect(done.status).toBe('done')
    expect(done.result).toEqual({ markdown: '# hi' })
    expect(done.startedAt).toBeTruthy()
    expect(done.finishedAt).toBeTruthy()
  })

  it('records per-stage wall clock, in the order the stages actually ran', async () => {
    let t = 1000
    const now = () => t
    const converter = makeConverter({
      kind: 'identify',
      stages: ['media', 'asr', 'diarize'],
      async run(ctx) {
        await ctx.stage('media', async () => { t += 100 })
        await ctx.stage('asr', async () => { t += 900 })
        await ctx.stage('diarize', async () => { t += 500 })
        return { ok: true, result: { text: 'x' } }
      },
    })
    const { runner } = setup([converter], { now })
    const { record } = runner.start('identify', 'i', {})
    await settle()
    const done = runner.get(record.id)!
    expect(done.timing).toEqual({
      totalMs: 1500,
      stages: [
        { name: 'media', ms: 100 },
        { name: 'asr', ms: 900 },
        { name: 'diarize', ms: 500 },
      ],
    })
  })

  it('omits stages that never ran rather than reporting them as 0ms', async () => {
    let t = 0
    const converter = makeConverter({
      kind: 'identify',
      stages: ['media', 'asr', 'diarize'],
      async run(ctx) {
        await ctx.stage('media', async () => { t += 10 })
        await ctx.stage('asr', async () => { t += 20 })
        return { ok: true, result: { text: 'x' } } // diarize never happened
      },
    })
    const { runner } = setup([converter], { now: () => t })
    const { record } = runner.start('identify', 'i', {})
    await settle()
    expect(runner.get(record.id)!.timing!.stages.map((s) => s.name)).toEqual(['media', 'asr'])
  })

  it('times a failed run too — a slow failure is the interesting one', async () => {
    let t = 0
    const converter = makeConverter({
      async run(ctx) {
        await ctx.stage('fetch', async () => { t += 700 })
        return { ok: false, error: { code: 'no_source', message: 'no parseable source' } }
      },
    })
    const { runner } = setup([converter], { now: () => t })
    const { record } = runner.start('extract', 'i', {})
    await settle()
    const rec = runner.get(record.id)!
    expect(rec.status).toBe('error')
    expect(rec.error).toEqual({ code: 'no_source', message: 'no parseable source' })
    expect(rec.timing!.stages).toEqual([{ name: 'fetch', ms: 700 }])
  })

  it('turns a converter throw into a structured error, not an unhandled rejection', async () => {
    const converter = makeConverter({ async run() { throw new Error('boom') } })
    const { runner } = setup([converter])
    const { record } = runner.start('extract', 'i', {})
    await settle()
    const rec = runner.get(record.id)!
    expect(rec.status).toBe('error')
    expect(rec.error).toEqual({ code: 'internal_error', message: 'boom' })
  })

  // 「这条结果是谁做的」——同一条 OCR，白嫖的视觉模型出的还是本地 MinerU 兜的底，事后必须
  // 分得开。走法在 executor 里一直算着，只是过去没往记录上落。
  it('落下梯子走法：谁赢了 + 每一档各花多久', async () => {
    const ladder = {
      via: 'zhipu',
      rungs: [
        { member: 'zhipu', source: 'ocr-vlm', ms: 4701, outcome: 'win' as const },
      ],
    }
    const { runner } = setup([makeConverter({ async run() { return { ok: true, result: { markdown: 'x' }, ladder } } })])
    const { record } = runner.start('extract', 'item-1', {})
    await settle()
    expect(runner.get(record.id)!.ladder).toEqual(ladder)
  })

  // 失败那条路**尤其**要留走法：「为什么没出结果」的答案就是「每一档分别怎么了」。
  it('失败也留走法——弃权和报错在里面分得开', async () => {
    const ladder = {
      via: null,
      rungs: [
        { member: 'zhipu', source: 'ocr-vlm', ms: 3, outcome: 'miss' as const, reason: '未配置' },
        { member: 'ocr-mineru', source: 'ocr-mineru', ms: 900, outcome: 'error' as const, reason: '502' },
      ],
    }
    const { runner } = setup([
      makeConverter({ async run() { return { ok: false, error: { code: 'x', message: 'boom' }, ladder } } }),
    ])
    const { record } = runner.start('extract', 'item-1', {})
    await settle()
    const rec = runner.get(record.id)!
    expect(rec.status).toBe('error')
    expect(rec.ladder).toEqual(ladder)
  })

  // converter 直接抛的那条路（parse 就是这么写的）：普通 Error 会把走法丢在 catch 之前，
  // 所以约定抛 LadderError。
  it('抛 LadderError 时走法照样进记录（普通 Error 则没有）', async () => {
    const ladder = { via: null, rungs: [{ member: 'a', source: 's', ms: 1, outcome: 'error' as const }] }
    const { runner: withTrace } = setup([
      makeConverter({ async run() { throw new LadderError('炸了', ladder) } }),
    ])
    const a = withTrace.start('extract', 'item-1', {})
    await settle()
    expect(withTrace.get(a.record.id)!.ladder).toEqual(ladder)
    expect(withTrace.get(a.record.id)!.error?.message).toBe('炸了')

    const { runner: plain } = setup([makeConverter({ async run() { throw new Error('炸了') } })])
    const b = plain.start('extract', 'item-2', {})
    await settle()
    expect(plain.get(b.record.id)!.ladder).toBeUndefined()
  })

  it('dedupes a non-error record instead of re-charging the backend', async () => {
    const run = vi.fn(async () => ({ ok: true as const, result: { markdown: 'x' } }))
    const { runner } = setup([makeConverter({ run })])
    const first = runner.start('extract', 'i', {})
    await settle()
    const second = runner.start('extract', 'i', {})
    expect(second.created).toBe(false)
    expect(second.record.id).toBe(first.record.id)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('re-runs an errored record, and re-runs a done one only under force', async () => {
    let outcome: { ok: boolean } = { ok: false }
    const run = vi.fn(async () =>
      outcome.ok ? { ok: true as const, result: { markdown: 'x' } } : { ok: false as const, error: { code: 'e', message: 'm' } }
    )
    const { runner } = setup([makeConverter({ run })])
    runner.start('extract', 'i', {})
    await settle()

    outcome = { ok: true }
    const retry = runner.start('extract', 'i', {}) // error → re-runs without force
    expect(retry.created).toBe(true)
    await settle()
    expect(runner.get(retry.record.id)!.status).toBe('done')

    expect(runner.start('extract', 'i', {}).created).toBe(false) // done → cached
    expect(runner.start('extract', 'i', { force: true }).created).toBe(true)
    await settle()
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('runs serially and reports 1-based queue positions', async () => {
    const gate: Array<() => void> = []
    const converter = makeConverter({
      async run() {
        await new Promise<void>((resolve) => gate.push(resolve))
        return { ok: true, result: {} }
      },
    })
    const { runner } = setup([converter])
    const a = runner.start('extract', 'a', {})
    const b = runner.start('extract', 'b', {})
    const c = runner.start('extract', 'c', {})
    await settle()

    expect(runner.get(a.record.id)!.status).toBe('running')
    expect(runner.list({ item: 'b' }).items[0].queuePos).toBe(1)
    expect(runner.list({ item: 'c' }).items[0].queuePos).toBe(2)

    gate.shift()!()
    await settle()
    expect(runner.get(b.record.id)!.status).toBe('running')
    expect(runner.list({ item: 'c' }).items[0].queuePos).toBe(1)
  })

  it('cancel dequeues a waiting job and drops its record', async () => {
    const gate: Array<() => void> = []
    const converter = makeConverter({
      async run() {
        await new Promise<void>((resolve) => gate.push(resolve))
        return { ok: true, result: {} }
      },
    })
    const { runner } = setup([converter])
    runner.start('extract', 'a', {})
    const b = runner.start('extract', 'b', {})
    await settle()

    expect(runner.cancel(b.record.id)).toBe(true)
    expect(runner.get(b.record.id)).toBeNull()
    gate.shift()!()
    await settle()
  })

  it('cancel aborts a running job, signals the converter, and drops the record', async () => {
    let seenAbort = false
    const converter = makeConverter({
      async run(ctx) {
        await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve()))
        seenAbort = ctx.signal.aborted
        return { ok: true, result: {} }
      },
    })
    const { runner } = setup([converter])
    const a = runner.start('extract', 'a', {})
    await settle()
    expect(runner.cancel(a.record.id)).toBe(true)
    await settle()
    expect(seenAbort).toBe(true)
    expect(runner.get(a.record.id)).toBeNull()
  })

  it('requeues a retryable failure after a delay instead of failing it outright', async () => {
    const scheduled: Array<{ fn: () => void; ms: number }> = []
    let attempts = 0
    const converter = makeConverter({
      async run() {
        attempts += 1
        if (attempts === 1) return { ok: false, error: { code: 'wake_timeout', message: 'still warming' }, retryable: true }
        return { ok: true, result: { markdown: 'ok' } }
      },
    })
    const { runner } = setup([converter], { schedule: (fn, ms) => { scheduled.push({ fn, ms }) } })
    const { record } = runner.start('extract', 'i', {})
    await settle()

    expect(runner.get(record.id)!.status).toBe('queued') // NOT error — intent is still alive
    expect(scheduled).toHaveLength(1)
    scheduled[0].fn()
    await settle()
    expect(runner.get(record.id)!.status).toBe('done')
    expect(attempts).toBe(2)
  })

  it('gives up on a retryable failure once the attempt budget is spent', async () => {
    const scheduled: Array<() => void> = []
    const converter = makeConverter({
      async run() {
        return { ok: false, error: { code: 'wake_timeout', message: 'still warming' }, retryable: true }
      },
    })
    const { runner } = setup([converter], { schedule: (fn) => { scheduled.push(fn) } })
    const { record } = runner.start('extract', 'i', {})
    await settle()
    for (let i = 0; i < 5 && scheduled.length; i += 1) {
      scheduled.shift()!()
      await settle()
    }
    const rec = runner.get(record.id)!
    expect(rec.status).toBe('error')
    expect(rec.error!.code).toBe('wake_timeout')
  })

  it('rejects an unavailable kind before creating a record', () => {
    const { runner, store } = setup([makeConverter({ available: () => false })])
    expect(() => runner.start('extract', 'i', {})).toThrowError(/unavailable/)
    expect(store.list({}).items).toEqual([])
  })

  it('rejects an unknown kind', () => {
    const { runner } = setup([makeConverter()])
    expect(() => runner.start('summary', 'i', {})).toThrowError(/unknown/)
  })

  it('marks rows left running/queued by a previous process as interrupted', () => {
    const store = new ConversionStore(':memory:')
    const orphan = store.create({ kind: 'extract', itemId: 'i' })
    store.update(orphan.id, { status: 'running' })
    const runner = new ConversionRunner({ store, converters: [makeConverter()], derivations: [], costarts: [] })
    const rec = runner.get(orphan.id)!
    expect(rec.status).toBe('error')
    expect(rec.error!.code).toBe('interrupted')
  })

  describe('job ledger', () => {
    function ledgerSpy() {
      const calls: string[] = []
      let n = 0
      return {
        calls,
        ledger: {
          enqueue: (kind: string) => { calls.push(`enqueue:${kind}`); return `job-${(n += 1)}` },
          markRunning: (id: string) => calls.push(`running:${id}`),
          complete: (id: string) => calls.push(`complete:${id}`),
          fail: (id: string, err: string) => calls.push(`fail:${id}:${err}`),
          jobDirOf: (id: string) => `/tmp/jobs/${id}`,
        },
      }
    }

    it('books a successful run: enqueue → running → complete', async () => {
      const { calls, ledger } = ledgerSpy()
      const store = new ConversionStore(':memory:')
      const runner = new ConversionRunner({ store, converters: [makeConverter()], ledger, derivations: [], costarts: [] })
      runner.start('extract', 'i', {})
      await settle()
      expect(calls).toEqual(['enqueue:extract', 'running:job-1', 'complete:job-1'])
    })

    it('leaves an error row for a failed run instead of wiping it', async () => {
      const { calls, ledger } = ledgerSpy()
      const store = new ConversionStore(':memory:')
      const converter = makeConverter({ async run() { return { ok: false, error: { code: 'x', message: 'nope' } } } })
      const runner = new ConversionRunner({ store, converters: [converter], ledger, derivations: [], costarts: [] })
      runner.start('extract', 'i', {})
      await settle()
      expect(calls).toContain('fail:job-1:nope')
    })

    it('completes the ledger row when the user cancels — intent destroyed, not failed', async () => {
      const { calls, ledger } = ledgerSpy()
      const store = new ConversionStore(':memory:')
      const gate: Array<() => void> = []
      const converter = makeConverter({
        async run() {
          await new Promise<void>((resolve) => gate.push(resolve))
          return { ok: true, result: {} }
        },
      })
      const runner = new ConversionRunner({ store, converters: [converter], ledger, derivations: [], costarts: [] })
      const { record } = runner.start('extract', 'i', {})
      await settle()
      runner.cancel(record.id)
      expect(calls).toContain('complete:job-1')
      expect(calls.some((c) => c.startsWith('fail:'))).toBe(false)
      gate.shift()?.()
      await settle()
    })

    it('resumes what the previous process left queued — the ledger remembers the intent', async () => {
      const store = new ConversionStore(':memory:')
      const orphan = store.create({ kind: 'extract', itemId: 'i' })
      store.update(orphan.id, { status: 'running' })
      const { ledger } = ledgerSpy()
      const runner = new ConversionRunner({
        store,
        converters: [makeConverter()],
        ledger: { ...ledger, recover: () => [{ jobId: 'job-old', kind: 'extract', input: { conversionId: orphan.id } }] },
        derivations: [], costarts: [],
      })
      await settle()
      expect(runner.get(orphan.id)!.status).toBe('done') // 续跑跑完了，不是让用户重点一次
    })

    it('does not resume a job whose record already finished or vanished', async () => {
      const store = new ConversionStore(':memory:')
      const finished = store.create({ kind: 'extract', itemId: 'i' })
      store.update(finished.id, { status: 'done', result: { markdown: 'old' } })
      const { calls, ledger } = ledgerSpy()
      new ConversionRunner({
        store,
        converters: [makeConverter()],
        ledger: {
          ...ledger,
          recover: () => [
            { jobId: 'job-done', kind: 'extract', input: { conversionId: finished.id } },
            { jobId: 'job-gone', kind: 'extract', input: { conversionId: 'cv_vanished' } },
          ],
        },
        derivations: [], costarts: [],
      })
      await settle()
      expect(calls).toContain('complete:job-done') // 意图已满足 = 完成，不是失败
      expect(calls).toContain('fail:job-gone:恢复时记录已不存在')
      expect((store.get(finished.id)!.result as { markdown: string }).markdown).toBe('old') // 没被重跑覆盖
    })

    it('refuses to resume when that kind backend is no longer available', async () => {
      const store = new ConversionStore(':memory:')
      const orphan = store.create({ kind: 'extract', itemId: 'i' })
      store.update(orphan.id, { status: 'queued' })
      const { calls, ledger } = ledgerSpy()
      const runner = new ConversionRunner({
        store,
        converters: [makeConverter({ available: () => false })],
        ledger: { ...ledger, recover: () => [{ jobId: 'job-old', kind: 'extract', input: { conversionId: orphan.id } }] },
        derivations: [], costarts: [],
      })
      await settle()
      expect(calls.some((c) => c.startsWith('fail:job-old:'))).toBe(true)
      expect(runner.get(orphan.id)!.error!.code).toBe('interrupted') // 落回安全网，用户可重试
    })

    it('hands the converter a per-job scratch dir for resumable work', async () => {
      const { ledger } = ledgerSpy()
      const store = new ConversionStore(':memory:')
      let seen: string | undefined
      const converter = makeConverter({
        async run(ctx) {
          seen = ctx.jobDir
          return { ok: true, result: {} }
        },
      })
      const runner = new ConversionRunner({ store, converters: [converter], ledger, derivations: [], costarts: [] })
      runner.start('extract', 'i', {})
      await settle()
      expect(seen).toBe('/tmp/jobs/job-1')
    })
  })

  describe('transcript accessors (what the voiceprint routes read/write)', () => {
    const SEGS = [
      { start: 0, end: 2, text: 'a', speaker: 'SPEAKER_00' },
      { start: 2, end: 4, text: 'b', speaker: 'SPEAKER_01' },
    ]
    function withTranscript() {
      const store = new ConversionStore(':memory:')
      const runner = new ConversionRunner({ store, converters: [makeConverter()], derivations: [], costarts: [] })
      const rec = store.create({ kind: 'extract', itemId: 'i' })
      store.update(rec.id, {
        status: 'done',
        result: { text: 'hello', format: 'plain', branch: 'stt', detail: { lang: 'zh', segments: SEGS, media: [{ url: 'm' }] } },
      })
      return { store, runner, rec }
    }

    it('reads the latest transcript and its segments', () => {
      const { runner } = withTranscript()
      expect(runner.transcriptOf('i')!.status).toBe('done')
      expect(runner.segmentsOf('i')).toEqual(SEGS)
      expect(runner.segmentsOf('nope')).toEqual([])
    })

    it('segmentsOf ignores a transcript that is not done', () => {
      const store = new ConversionStore(':memory:')
      const runner = new ConversionRunner({ store, converters: [makeConverter()], derivations: [], costarts: [] })
      const rec = store.create({ kind: 'extract', itemId: 'i' })
      store.update(rec.id, { status: 'error', error: { code: 'x', message: 'y' } })
      expect(runner.segmentsOf('i')).toEqual([])
    })

    it('allTranscripts yields one entry per item, skipping empty and unfinished ones', () => {
      const store = new ConversionStore(':memory:')
      const runner = new ConversionRunner({ store, converters: [makeConverter()], derivations: [], costarts: [] })
      const stt = (segments: typeof SEGS) => ({ text: 't', format: 'plain', branch: 'stt', detail: { segments } })
      const a = store.create({ kind: 'extract', itemId: 'a' })
      store.update(a.id, { status: 'done', result: stt(SEGS) })
      const bOld = store.create({ kind: 'extract', itemId: 'b' })
      store.update(bOld.id, { status: 'done', result: stt([]) }) // 是转写但一段都没切出来 → 跳过
      const c = store.create({ kind: 'extract', itemId: 'c' })
      store.update(c.id, { status: 'running' }) // 未完成 → 跳过
      const d = store.create({ kind: 'extract', itemId: 'd' })
      store.update(d.id, { status: 'done', result: { text: '# 图', format: 'markdown', branch: 'ocr' } }) // 非转写分支 → 跳过
      const aNewer = store.create({ kind: 'extract', itemId: 'a' }) // 同 item 第二条 → 只取最新
      store.update(aNewer.id, { status: 'done', result: stt([SEGS[0]]) })

      const all = runner.allTranscripts()
      expect(all.map((t) => t.itemId)).toEqual(['a'])
      expect(all[0].segments).toHaveLength(1) // 最新那条
    })
  })

  it('lists the available kinds with their declared stages', () => {
    const { runner } = setup([
      makeConverter(),
      makeConverter({ kind: 'identify', label: '补说话人', stages: ['media', 'asr'], available: () => false }),
    ])
    expect(runner.kinds()).toEqual([
      { kind: 'extract', label: '转成文字', stages: ['fetch', 'ocr'], available: true, options: {} },
      { kind: 'identify', label: '补说话人', stages: ['media', 'asr'], available: false, options: {} },
    ])
  })
})

describe('ConversionRunner 自动派生', () => {
  /** 上游：一条产出带时间轴结果的 extract。 */
  const upstream = makeConverter({
    kind: 'extract',
    async run() {
      return { ok: true, result: { text: 'hi', format: 'plain', branch: 'stt', detail: { segments: [{ start: 0, end: 1, text: 'hi' }] } } }
    },
  })

  it('上游成功后按规则排出下游，并把上游 id 记成 inputId', async () => {
    const downstream = makeConverter({ kind: 'identify', async run() { return { ok: true, result: { named: 1 } } } })
    const { runner } = setup([upstream, downstream], {
      derivations: [{ from: 'extract', to: 'identify', when: () => true }],
    })
    const { record } = runner.start('extract', 'item-1', {})
    await settle()
    await settle() // 派生那条要多一轮 pump 才跑完
    const derived = runner.list({ item: 'item-1', kind: 'identify' }).items
    expect(derived).toHaveLength(1)
    expect(derived[0]!.status).toBe('done')
    expect(derived[0]!.inputId).toBe(record.id)
  })

  it('规则说不派就不派——不留任何记录', async () => {
    const downstream = makeConverter({ kind: 'identify' })
    const { runner } = setup([upstream, downstream], {
      derivations: [{ from: 'extract', to: 'identify', when: () => false }],
    })
    runner.start('extract', 'item-1', {})
    await settle()
    await settle()
    expect(runner.list({ item: 'item-1', kind: 'identify' }).items).toHaveLength(0)
  })

  it('下游后端没配时，派生被吞掉，上游那条仍然是 done，且不产生 unhandled rejection', async () => {
    const downstream = makeConverter({ kind: 'identify', available: () => false })
    const { runner } = setup([upstream, downstream], {
      derivations: [{ from: 'extract', to: 'identify', when: () => true }],
    })
    let record!: ReturnType<typeof runner.start>['record']
    const caught = await withUnhandledCapture(async () => {
      record = runner.start('extract', 'item-1', {}).record
      await settle()
      await settle()
    })
    expect(runner.get(record.id)!.status).toBe('done')
    expect(runner.list({ item: 'item-1', kind: 'identify' }).items).toHaveLength(0)
    expect(caught).toHaveLength(0)
  })

  it('一条派生规则的后端没配，不连累同一轮里其他规则——各自独立 try/catch', async () => {
    // 第一条规则的目标后端没配（available: () => false，start() 会抛），第二条正常。
    // 修复前两条规则共用一个 try/catch 包住整个循环：第一条抛出会让循环提前退出，
    // 第二条虽然规则表里排着但永远不会被 start() 调到。
    const unavailable = makeConverter({ kind: 'identify', available: () => false })
    const ok = makeConverter({ kind: 'summary', async run() { return { ok: true, result: { text: 'ok' } } } })
    const { runner } = setup([upstream, unavailable, ok], {
      derivations: [
        { from: 'extract', to: 'identify', when: () => true },
        { from: 'extract', to: 'summary', when: () => true },
      ],
    })
    const caught = await withUnhandledCapture(async () => {
      runner.start('extract', 'item-1', {})
      await settle()
      await settle()
    })
    expect(runner.list({ item: 'item-1', kind: 'identify' }).items).toHaveLength(0)
    const derived = runner.list({ item: 'item-1', kind: 'summary' }).items
    expect(derived).toHaveLength(1)
    expect(derived[0]!.status).toBe('done')
    expect(caught).toHaveLength(0)
  })

  it('派生规则的 when 谓词抛错不能穿透——上游那条仍然是 done，且不产生 unhandled rejection', async () => {
    const downstream = makeConverter({ kind: 'identify' })
    const { runner } = setup([upstream, downstream], {
      derivations: [{
        from: 'extract',
        to: 'identify',
        when: () => { throw new Error('boom') },
      }],
    })
    let record!: ReturnType<typeof runner.start>['record']
    const caught = await withUnhandledCapture(async () => {
      record = runner.start('extract', 'item-1', {}).record
      await settle()
      await settle()
    })
    expect(runner.get(record.id)!.status).toBe('done')
    expect(runner.list({ item: 'item-1', kind: 'identify' }).items).toHaveLength(0)
    expect(caught).toHaveLength(0)
  })

  it('上游失败不派生', async () => {
    const failing = makeConverter({
      kind: 'extract',
      async run() { return { ok: false, error: { code: 'boom', message: 'boom' } } },
    })
    const downstream = makeConverter({ kind: 'identify' })
    const { runner } = setup([failing, downstream], {
      derivations: [{ from: 'extract', to: 'identify', when: () => true }],
    })
    runner.start('extract', 'item-1', {})
    await settle()
    await settle()
    expect(runner.list({ item: 'item-1', kind: 'identify' }).items).toHaveLength(0)
  })

  it('上游真的重跑过就重排下游——旧那条是对着旧产物算的', async () => {
    const downstream = makeConverter({ kind: 'identify', async run() { return { ok: true, result: {} } } })
    const { runner } = setup([upstream, downstream], {
      derivations: [{ from: 'extract', to: 'identify', when: () => true }],
    })
    runner.start('extract', 'item-1', {})
    await settle()
    await settle()
    expect(runner.list({ item: 'item-1', kind: 'identify' }).items).toHaveLength(1)

    runner.start('extract', 'item-1', { force: true })
    await settle()
    await settle()
    // 两条：旧的那条对着旧转写，新的对着新转写。不重排的表现是「重转写之后说话人永远补不上」。
    expect(runner.list({ item: 'item-1', kind: 'identify' }).items).toHaveLength(2)
  })

  it('上一轮的 identify 还在跑时上游又重跑——旧那条对着旧上游，必须照样重排第二条', async () => {
    let release: (() => void) | undefined
    const slow = makeConverter({
      kind: 'identify',
      async run() {
        await new Promise<void>((r) => { release = r })
        return { ok: true, result: {} }
      },
    })
    const { runner } = setup([upstream, slow], {
      derivations: [{ from: 'extract', to: 'identify', when: () => true }],
      // 两个槽：第一槽被卡住的 identify 占着，第二槽必须能跑完重排的 extract 才能真的
      // 走到 deriveFrom——否则重排的 extract 会一直卡在队列里等槽（maxConcurrent 默认 1），
      // 断言窗口内根本没到 deriveFrom，守卫删不删都观测不到。
      maxConcurrent: 2,
    })
    runner.start('extract', 'item-1', {})
    await settle()
    await settle()
    expect(runner.list({ item: 'item-1', kind: 'identify' }).items).toHaveLength(1)

    // 第一条 identify 还卡在 run() 里没落定（inputId 指向第一条 extract），此时上游又跑了一遍。
    // 按身份判：新上游这条的 inputId 跟那条卡住的 identify 不一样，必须照样排出第二条——
    // 不然那条卡住的 identify 跑完只会回灌进第一条旧 extract，新 extract 永远补不上说话人。
    runner.start('extract', 'item-1', { force: true })
    await settle()
    await settle()
    expect(runner.list({ item: 'item-1', kind: 'identify' }).items).toHaveLength(2)

    release?.()
    await settle()
  })

  it('派生出来的 identify，inputId 必须指向本轮这条 extract', async () => {
    const downstream = makeConverter({ kind: 'identify', async run() { return { ok: true, result: {} } } })
    const { runner } = setup([upstream, downstream], {
      derivations: [{ from: 'extract', to: 'identify', when: () => true }],
    })
    const { record } = runner.start('extract', 'item-1', {})
    await settle()
    await settle()
    const derived = runner.list({ item: 'item-1', kind: 'identify' }).items
    expect(derived).toHaveLength(1)
    expect(derived[0]!.inputId).toBe(record.id)

    // 上游重跑一次：新派生的那条 inputId 必须换成新的上游 id，不能沿用旧的。
    const { record: record2 } = runner.start('extract', 'item-1', { force: true })
    await settle()
    await settle()
    const derivedAfter = runner.list({ item: 'item-1', kind: 'identify' }).items
    expect(derivedAfter).toHaveLength(2)
    const latest = derivedAfter.find((d) => d.id !== derived[0]!.id)!
    expect(latest.inputId).toBe(record2.id)
  })
})

describe('ConversionRunner 并肩起跑', () => {
  const slow = makeConverter({ kind: 'extract', async run() { return { ok: true, result: { text: 'hi' } } } })

  it('起一条就把并肩那条一起排上——不等它跑完', async () => {
    const started: string[] = []
    const sidekick = makeConverter({
      kind: 'identify',
      async run() { started.push('identify'); return { ok: true, result: {} } },
    })
    const { runner } = setup([slow, sidekick], {
      costarts: [{ from: 'extract', to: 'identify', when: () => true }],
    })
    const { record } = runner.start('extract', 'item-1', {})

    // **同步就该在了**：并肩的意思是同时排队，不是上游落定之后才排。
    const sib = runner.list({ item: 'item-1', kind: 'identify' }).items
    expect(sib).toHaveLength(1)
    expect(sib[0]!.inputId).toBe(record.id) // 认得出并肩的是哪一条，好在跑完后去读它
    await settle()
    await settle()
    expect(started).toEqual(['identify'])
  })

  it('命中去重（没真起）时不并肩——否则每次点一下转成文字都白排一条声纹', async () => {
    const sidekick = makeConverter({ kind: 'identify' })
    const { runner } = setup([slow, sidekick], {
      costarts: [{ from: 'extract', to: 'identify', when: () => true }],
    })
    runner.start('extract', 'item-1', {})
    await settle()
    await settle()
    const first = runner.list({ item: 'item-1', kind: 'identify' }).items
    expect(first).toHaveLength(1) // 第一次真起了一条
    runner.remove(first[0]!.id) // 摘掉它，好让「第二次有没有再排」看得出来

    runner.start('extract', 'item-1', {}) // 第二次：上游命中去重，直接返回已有记录
    expect(runner.list({ item: 'item-1', kind: 'identify' }).items).toHaveLength(0)
  })

  it('并肩那条的后端没配 → 吞掉，发起的那条照跑，且不产生 unhandled rejection', async () => {
    const sidekick = makeConverter({ kind: 'identify', available: () => false })
    const { runner } = setup([slow, sidekick], {
      costarts: [{ from: 'extract', to: 'identify', when: () => true }],
    })
    const caught = await withUnhandledCapture(async () => {
      const { record } = runner.start('extract', 'item-1', {})
      await settle()
      expect(runner.get(record.id)!.status).toBe('done')
    })
    expect(caught).toEqual([])
  })

  it('when 谓词抛错不能穿透——发起的那条照跑', async () => {
    const sidekick = makeConverter({ kind: 'identify' })
    const { runner } = setup([slow, sidekick], {
      costarts: [{ from: 'extract', to: 'identify', when: () => { throw new Error('boom') } }],
    })
    const { record } = runner.start('extract', 'item-1', {})
    await settle()
    expect(runner.get(record.id)!.status).toBe('done')
    expect(runner.list({ item: 'item-1', kind: 'identify' }).items).toHaveLength(0)
  })

  it('options 原样递给并肩那条——媒体线索就在里面，少了它并肩那条必然 no_media', async () => {
    let seen: unknown
    const sidekick = makeConverter({
      kind: 'identify',
      async run(ctx) { seen = ctx.options.media; return { ok: true, result: {} } },
    })
    const { runner } = setup([slow, sidekick], {
      costarts: [{ from: 'extract', to: 'identify', when: () => true }],
    })
    runner.start('extract', 'item-1', { options: { media: [{ kind: 'audio' }] } })
    await settle()
    await settle()
    expect(seen).toEqual([{ kind: 'audio' }])
  })
})
