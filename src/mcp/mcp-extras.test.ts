import { describe, it, expect, vi } from 'vitest'
import { buildMcpExtras, type McpExtrasDeps } from './mcp-extras.ts'

// 收发都用 McpExtrasDeps（不是 `Partial<Boot>`）：`conversions` / `readUrl` 在 deps 上是**必有**
// 字段，漏接线是 typecheck 错误而不是运行时静默少一个工具——测试的 fake 也得守同一条,
// 否则这里就成了绕过口。
function fakeBoot(overrides: Partial<McpExtrasDeps> = {}): McpExtrasDeps {
  return {
    intentResolver: { resolve: (input: string) => ({ targetType: 'tt', key: input }) },
    resolveEngine: { resolve: async (tt: string, key: string) => ({ tt, key }) },
    registry: {
      // minimal-but-valid SourceManifest so publicSource() can project it
      providersOf: (tt: string) => [{
        id: `${tt}-provider`, provides: [tt], priority: 1, pluginId: 'rsshub', title: `${tt}-provider`,
        adapter: 'rsshub', description: `${tt} src`, auth: { type: 'none' }, params_schema: {}, capabilities: [],
      }],
      all: () => [],
    },
    sourceHealth: { stateOf: (id: string) => `health-of-${id}` },
    videoSearch: async () => ({ shows: [], loose: [], sources: [] }),
    itemStore: { get: (id: string) => (id === 'i1' ? { title: 'T', stream_id: 's1', url: 'u1', content: {} } : undefined) },
    // 转换的唯一入口:触发(start)、读取(list)、能力发现(kinds) 全经 runner。
    conversions: {
      kinds: () => [
        { kind: 'extract', label: '转成文字', stages: [], available: true, options: {} },
      ],
      list: (q: Record<string, unknown>) => ({ items: [{ id: 'cv_1', query: q }] }),
      start: (kind: string, itemId: string, opts: { snapshot?: { title?: string } }) => ({
        record: `started-${kind}-${itemId}-${opts.snapshot?.title}`,
        created: true,
      }),
    },
    contentSearch: async (q: string) => [{ title: `content for ${q}` }],
    // 默认不喂 digest——大多数用例的 record 都不够长,门槛不触发,这里给个不会被叫到的假件。
    llmForTask: async () => null,
    ...overrides,
  } as unknown as McpExtrasDeps
}

describe('buildMcpExtras', () => {
  it('maps contentSearch straight through', async () => {
    const extras = buildMcpExtras(fakeBoot())
    expect(await extras.contentSearch!('q')).toEqual([{ title: 'content for q' }])
  })

  // 活体撞过一次：`purchaseDecide` 加进了 agent 域的 deps 表、格数自检也过了（那个数只数
  // deps），但这张**转发**表漏了一行——于是 `purchase_decide` 安静地不在工具清单里，
  // 不报错、不 404、只是不存在。类型层的 Pick 现在挡住它，这条测试是第二道。
  it('把 agent 域那几格原样转发出去——漏一格的表现是工具安静地不注册', async () => {
    const purchaseDecide = (async () => ({ marker: 'receipt' })) as never
    const extras = buildMcpExtras(fakeBoot({ purchaseDecide }))
    expect(await (extras.purchaseDecide as unknown as () => Promise<unknown>)()).toEqual({ marker: 'receipt' })
  })

  it('wires resolve.listSources to registry.providersOf with health', () => {
    const extras = buildMcpExtras(fakeBoot())
    const list = extras.resolve!.listSources('netease-track') as Array<Record<string, unknown>>
    // 展示字段统一走 publicSource;wiring 断言核心字段 + health
    expect(list[0]).toMatchObject({
      id: 'netease-track-provider', title: 'netease-track-provider', pluginId: 'rsshub', pluginName: 'rsshub',
      provides: ['netease-track'], priority: 1, health: 'health-of-netease-track-provider',
    })
  })

  // MCP 的 `resolve` 工具和 HTTP 的 `/api/resolutions` 是歌词的两条路。缓存壳只套在其中一条
  // 上的表现是**安静的**：这条路不报错、只是每次播放都去打一次上游，而两条路的单测都照常绿。
  describe('resolve.resolveTarget —— 歌词那一档经缓存壳', () => {
    const makeCache = () => {
      const store = new Map<string, { matched: boolean; songId?: string; lrc?: string }>()
      return { store, getLyricsCache: (k: string) => store.get(k) ?? null, putLyricsCache: (k: string, v: { matched: boolean }) => { store.set(k, v) } }
    }

    it('命中缓存 → 不跑梯子', async () => {
      const cache = makeCache()
      const entry = { matched: true, songId: '1', lrc: 'x' }
      cache.store.set('pkg:1', entry)
      let ran = false
      const extras = buildMcpExtras(
        fakeBoot({ audioArchive: cache as never, resolveEngine: { resolve: async () => { ran = true; return null } } as never }),
      )
      expect(await extras.resolve!.resolveTarget('lyrics', 'pkg:1')).toEqual({ source: 'lyrics-cache', items: [entry] })
      expect(ran).toBe(false)
    })

    it('未命中 → 跑梯子并写回', async () => {
      const cache = makeCache()
      const extras = buildMcpExtras(
        fakeBoot({ audioArchive: cache as never, resolveEngine: { resolve: async () => ({ source: 's', items: [{ matched: false }] }) } as never }),
      )
      await extras.resolve!.resolveTarget('lyrics', 'pkg:1')
      expect(cache.store.get('pkg:1')).toEqual({ matched: false })
    })

    it('别的 targetType 不碰缓存', async () => {
      const cache = makeCache()
      const extras = buildMcpExtras(fakeBoot({ audioArchive: cache as never }))
      expect(await extras.resolve!.resolveTarget('generic-url', 'https://x')).toEqual({ tt: 'generic-url', key: 'https://x' })
      expect(cache.store.size).toBe(0)
    })
  })

  it('extract 查到 item 之后起一条 extract 转换（一个工具，不分转写/OCR）', async () => {
    const extras = buildMcpExtras(fakeBoot())
    // record 未过 digest 门槛（不是 {status:'done',...} 形状）→ 原样透传,只是套了层 Promise。
    expect(await extras.extract!('i1')).toBe('started-extract-i1-T')
  })

  // 转换缓存只按 (item, kind) 认，**不看 options**（runner.start：命中非 error 记录就原样退回，
  // 见 runner.test.ts「re-runs a done one only under force」）。所以「已经取过正文的条目 + 刚
  // 拨开的识别发言人开关」唯一的出路就是 force——不透传的话用户拨了开关什么都不会发生，
  // 而且没有任何一处会报错。这条钉住 rerun→force 这一跳。
  it('rerun 透传成 conversions.start 的 force（缓存旁路），不带就不 force', () => {
    const calls: Array<Record<string, unknown>> = []
    const boot = fakeBoot({
      conversions: {
        kinds: () => [{ kind: 'extract', label: '转成文字', stages: [], available: true, options: {} }],
        list: () => ({ items: [] }),
        start: (_k: string, _i: string, o: Record<string, unknown>) => {
          calls.push(o)
          return { record: {}, created: true }
        },
      },
    } as never)
    const extras = buildMcpExtras(boot)
    extras.extract!('i1')
    extras.extract!('i1', { diarize: true, rerun: true })
    expect(calls[0].force).toBeFalsy()
    expect(calls[1].force).toBe(true)
    expect((calls[1].options as { diarize?: boolean }).diarize).toBe(true)
  })

  it('omits a trigger whose kind has no configured backend (button/tool simply absent)', () => {
    const extras = buildMcpExtras(
      fakeBoot({
        conversions: {
          kinds: () => [{ kind: 'extract', label: '转成文字', stages: [], available: false, options: {} }],
          list: () => ({ items: [] }),
          start: () => ({ record: {}, created: true }),
        },
      } as never),
    )
    expect(extras.extract).toBeUndefined()
  })

  it('未知 item 报错', () => {
    const extras = buildMcpExtras(fakeBoot())
    expect(extras.extract!('missing')).toEqual({ status: 'error', error: 'item not found' })
  })

  // 现搜结果不落库,但模型刚在 content_search 回执里见过它的 id——瞬时快照是 extract 句柄的
  // 第三命名空间(spec 2026-08-23-purchase-evidence-deepread §2.1)。搜之前同一个 id 必须还是
  // not found:快照只收「这次会话真搜出来过」的条目,不是一个万能后门。
  it('现搜命中的条目经瞬时快照可 extract;搜之前不行', async () => {
    const boot = fakeBoot({
      contentSearch: async () => [
        { id: 'hit1', title: '横评视频', stream_id: 'search:content', url: 'u', content: { archetype: 'video' } },
      ],
    } as never)
    const extras = buildMcpExtras(boot)
    expect(extras.extract!('hit1')).toEqual({ status: 'error', error: 'item not found' })
    await extras.contentSearch!('保温杯 横评')
    expect(await extras.extract!('hit1')).toBe('started-extract-hit1-横评视频')
  })

  // 视频的画面文字层(frames)是转写落定后**自动派生**的,而视频的正文在它落定之前是不完整的。
  // 判据全在 extract-frames-layer.ts,这里只钉接线:查得对(带 expandResult)、挂得上。
  // 这条工具天生要被调好几次(转写在跑、画面文字层在抽),所以每一格都要付 N 次。
  // 活体 2026-08-30 一轮 5 次,四次连 result 都没有,纯粹是 id 和时间戳在刷屏。
  it('回执是投影不是那条库记录：id/时间戳/timing/ladder/detail.media 一格都不进上下文', async () => {
    const fat = {
      id: 'cv_1', kind: 'extract', itemId: 'i1', status: 'done',
      snapshot: { title: 'T', source: 's1', url: 'u1' },
      timing: { totalMs: 2102, stages: [{ name: 'stt:asr', ms: 1419 }] },
      ladder: { via: 'groq', rungs: [] },
      createdAt: 'x', startedAt: 'y', finishedAt: 'z', updatedAt: 'w',
      result: { text: '短转写', format: 'plain', branch: 'stt', detail: { segments: [{ start: 0, end: 1, text: '短转写' }], media: [{ kind: 'video', embed: 'e'.repeat(600) }] } },
    }
    const extras = buildMcpExtras(
      fakeBoot({
        conversions: {
          kinds: () => [{ kind: 'extract', label: '转成文字', stages: [], available: true, options: {} }],
          list: () => ({ items: [] }),
          start: () => ({ record: fat, created: true }),
        },
      } as never),
    )
    const out = (await extras.extract!('i1')) as Record<string, any>
    expect(out.result.text).toBe('短转写')
    expect(out.result.detail.segments).toHaveLength(1)
    expect(out.snapshot).toEqual({ title: 'T', source: 's1', url: 'u1' }) // 卡片要它画标题/来源/链接
    for (const k of ['id', 'kind', 'itemId', 'timing', 'ladder', 'createdAt', 'updatedAt']) expect(out).not.toHaveProperty(k)
    expect(out.result.detail).not.toHaveProperty('media')
  })

  it('画面文字层还在跑 → extract 回执报 running 且不带 result;落定则把轨拼进来', async () => {
    const record = { status: 'done', result: { text: '短转写', format: 'plain', branch: 'stt' } }
    const seen: Array<Record<string, unknown>> = []
    const listFor = (frames: { status: string; result?: unknown } | undefined) => (q: Record<string, unknown>) => {
      seen.push(q)
      return { items: q.kind === 'frames' && frames !== undefined ? [{ id: 'cv_f', ...frames }] : [] }
    }
    const build = (frames: { status: string; result?: unknown } | undefined) =>
      buildMcpExtras(
        fakeBoot({
          conversions: {
            kinds: () => [{ kind: 'extract', label: '转成文字', stages: [], available: true, options: {} }],
            list: listFor(frames),
            start: () => ({ record, created: true }),
          },
        } as never),
      )

    const ready = (await build({
      status: 'done',
      result: { track: [{ at: 3.2, text: '中华慈善总会携手网球运动员郑钦文捐赠100万元' }] },
    }).extract!('i1')) as { status: string; on_screen_text: { text: string } }
    expect(ready.status).toBe('done')
    // 轨**直接拼在回执里**——不是指一条路让模型自己再去调 get_conversions。
    expect(ready.on_screen_text.text).toContain('中华慈善总会')
    // 查这条记录必须展开 result,否则只拿得到 status,又退回「指路 + 赌它照做」。
    expect(seen.some((q) => q.kind === 'frames' && q.expandResult === true)).toBe(true)

    // 现查而不是装配期取:frames 是转写落定后才出现的,冻住答案就永远是"没有那一层"。
    const waiting = (await build({ status: 'running' }).extract!('i1')) as Record<string, unknown>
    expect(waiting.status).toBe('running')
    expect(waiting).not.toHaveProperty('result') // 给了半份,模型就会拿它总结
    expect(waiting.waiting_for).toBe('on_screen_text')

    // 没有那一层(网页/图片/纯音频)→ 回执一个字都不多。
    const plain = (await build(undefined).extract!('i1')) as Record<string, unknown>
    expect(plain).not.toHaveProperty('on_screen_text')
    expect(plain.status).toBe('done')
  })

  it('extract:done 长文经 digest 层;focus 透传;没有 full 开关', async () => {
    const LONG = 'A'.repeat(5000)
    const record = { status: 'done', result: { text: LONG, format: 'plain', branch: 'stt' } }
    const llmForTask = vi.fn(async () => ({ content: '- 要点「引」' }))
    const extras = buildMcpExtras(
      fakeBoot({
        conversions: {
          kinds: () => [{ kind: 'extract', label: '转成文字', stages: [], available: true, options: {} }],
          list: () => ({ items: [] }),
          start: () => ({ record, created: true }),
        },
        llmForTask,
      } as never),
    )
    const out = (await extras.extract!('i1', { focus: '找型号' })) as { result: Record<string, unknown> }
    expect(out.result.digested).toBe(true)
    expect(out.result.text).toBe('- 要点「引」')
    // focus 进了 LLM 消息
    expect(JSON.stringify((llmForTask as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1])).toContain('找型号')
  })

  // rerun 重跑 conversion 后产物会变(如 diarize 加说话人标签),digest 缓存 30 分钟内不能挡在
  // 新产物前面——rerun:true 必须让 digester 跳过缓存读(bypassCache),重新打 LLM。
  it('rerun:true 透传 bypassCache,digest 不复用旧缓存', async () => {
    const LONG = 'A'.repeat(5000)
    const record = { status: 'done', result: { text: LONG, format: 'plain', branch: 'stt' } }
    const llmForTask = vi.fn()
      .mockResolvedValueOnce({ content: '- 旧稿要点' })
      .mockResolvedValueOnce({ content: '- 新稿要点(带说话人)' })
    const extras = buildMcpExtras(
      fakeBoot({
        conversions: {
          kinds: () => [{ kind: 'extract', label: '转成文字', stages: [], available: true, options: {} }],
          list: () => ({ items: [] }),
          start: () => ({ record, created: true }),
        },
        llmForTask,
      } as never),
    )
    const first = (await extras.extract!('i1')) as { result: Record<string, unknown> }
    expect(first.result.text).toBe('- 旧稿要点')
    const rerun = (await extras.extract!('i1', { rerun: true })) as { result: Record<string, unknown> }
    expect(rerun.result.text).toBe('- 新稿要点(带说话人)')
    expect(llmForTask).toHaveBeenCalledTimes(2)
  })

  it('passes the conversions query straight through to the runner (one filtering implementation)', () => {
    const extras = buildMcpExtras(fakeBoot())
    expect(extras.conversions!.list({ item: 'i1', kind: 'stt', limit: 5, expandResult: true })).toEqual({
      items: [{ id: 'cv_1', query: { item: 'i1', kind: 'stt', limit: 5, expandResult: true } }],
    })
  })

  it('omits the conversions surface when nothing is wired', () => {
    const extras = buildMcpExtras(fakeBoot({ conversions: undefined }))
    expect(extras.conversions).toBeUndefined()
  })
})

/** identify（补说话人）是**和 extract 平行的另一条轴**：只跑 diarization + 认名，不重跑 STT。
 *  它和 extract 共用同一套句柄解析与 snapshot，所以这几条钉的是「那套确实被复用了」，
 *  以及「kind 不可用时这一格是 undefined」——装上去只会让工具一路失败。 */
function identifyBoot(overrides: Record<string, unknown> = {}) {
  return fakeBoot({
    conversions: {
      kinds: () => [{ kind: 'identify', label: '补说话人', stages: [], available: true, options: {} }],
      list: () => ({ items: [] }),
      start: (kind: string, itemId: string, opts: { snapshot?: { title?: string } }) => ({
        record: `started-${kind}-${itemId}-${opts.snapshot?.title}`,
        created: true,
      }),
      ...overrides,
    },
  } as never)
}

describe('McpExtras.identify（起补说话人）', () => {
  it('kind 不可用时这一格是 undefined', () => {
    // fakeBoot 的默认 kinds 只有 extract → identify 不该被装上
    expect(buildMcpExtras(fakeBoot()).identify).toBeUndefined()
  })

  it('起一条 identify，snapshot 与 extract 那格同口径', () => {
    const extras = buildMcpExtras(identifyBoot())
    expect(extras.identify!('i1')).toBe('started-identify-i1-T')
  })

  it('认不出的 handle 回错误壳，不建半条记录', () => {
    const extras = buildMcpExtras(identifyBoot())
    expect(extras.identify!('missing')).toEqual({ status: 'error', error: 'item not found' })
  })

  // 缓存只按 (item, kind) 认：不 force 就是静默退回上一次的结果，用户说了「重新识别」却什么都没发生。
  it('rerun 透传成 force', () => {
    const calls: Array<Record<string, unknown>> = []
    const extras = buildMcpExtras(
      identifyBoot({
        start: (_k: string, _i: string, o: Record<string, unknown>) => {
          calls.push(o)
          return { record: {}, created: true }
        },
      }),
    )
    extras.identify!('i1')
    extras.identify!('i1', { rerun: true })
    expect(calls[0].force).toBeFalsy()
    expect(calls[1].force).toBe(true)
  })

  /**
   * **「这个 kind 配好了没」是每次现问的，不是开机那一刻的快照。**
   *
   * 声纹容器归 standby 管，boot 那一刻多半还睡着 —— 冻住答案就等于让 `identify_speakers`
   * 在整个进程生命期里都不注册（工具注册门读的就是 extras 这一格）。同一条教训在
   * `kernel/plugins/conversions.ts` 的 identifyReady 头注里写过一遍，这里是它在工具面这一侧
   * 的守卫：把 `get identify()` 改回普通字段，这条当场变红。
   */
  it('kind 的可用性每次现问：boot 时不可用、后来醒了 → 工具面跟得上', () => {
    let awake = false
    const extras = buildMcpExtras(
      identifyBoot({
        kinds: () => [{ kind: 'identify', label: '补说话人', stages: [], available: awake, options: {} }],
      }),
    )
    expect(extras.identify).toBeUndefined() // 还睡着 → 工具不注册
    awake = true
    expect(typeof extras.identify).toBe('function') // 醒了 → 同一份 extras 就已经给得出它
  })
})

