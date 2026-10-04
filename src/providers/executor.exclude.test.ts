import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UserStore } from '../store/user-store.ts'
import { Registry } from '../registry/registry.ts'
import { ProviderStatsStore } from './stats-store.ts'
import { ProviderExecutor } from './executor.ts'
import { ProviderDirectory } from './directory.ts'
import { SYSTEM_IDENTITIES } from './system/index.ts'

/** Task 2：executor 按次调用排除 excludeMembers——与行上持久化 options.exclude 取并集，
 *  按寻址键（name ?? source）过滤。造行方式照抄 executor.test.ts 的既有夹具。 */
describe('ProviderExecutor — excludeMembers (per-call)', () => {
  let dir: string
  let store: UserStore
  let stats: ProviderStatsStore
  let fetched: Array<{ sourceId: string; input: unknown }>
  let behaviors: Record<string, (input: unknown, params?: Record<string, unknown>) => Promise<unknown[] | Record<string, unknown> | null>>
  let exec: ProviderExecutor

  const registry = new Registry([])

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'exec-exclude-'))
    store = new UserStore(join(dir, 'stream.db'))
    stats = new ProviderStatsStore(join(dir, 'cache.db'))
    fetched = []
    behaviors = {}
    exec = new ProviderExecutor({
      directory: new ProviderDirectory(store, SYSTEM_IDENTITIES), registry, stats,
      fetchSource: async (sourceId, input, params) => {
        fetched.push({ sourceId, input })
        const b = behaviors[sourceId]
        if (!b) throw new Error(`no behavior for ${sourceId}`)
        return b(input, params)
      },
    })
  })
  afterEach(() => {
    store.close()
    stats.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function putProvider(p: Partial<Parameters<UserStore['putProvider']>[0]> & { id: string }) {
    store.putProvider({
      label: '', description: '', category: 'resolve', serves: [], strategy: 'sequential',
      members: [], contract: null, options: {}, ...p,
    })
  }

  it('excludeMembers 按次排除：A 被排除时不再被 attempt，B 答', async () => {
    behaviors['llm-openai'] = async (_input, params) => (params?.tag === 'A' ? [{ ok: 'A' }] : [{ ok: 'B' }])
    putProvider({
      id: 'llmseq', category: 'llm', strategy: 'sequential',
      members: [
        { source: 'llm-openai', name: 'A', params: { tag: 'A' } },
        { source: 'llm-openai', name: 'B', params: { tag: 'B' } },
      ],
    })

    // baseline: 不传 excludeMembers 时 A 先答
    const r0 = (await exec.invoke('llmseq', 'q'))!
    expect(r0).toMatchObject({ via: 'A' })

    fetched = []
    const r = (await exec.invoke('llmseq', 'q', { excludeMembers: ['A'] }))!
    expect(r).toMatchObject({ via: 'B' })
    expect(fetched.map((f) => f.sourceId)).toEqual(['llm-openai']) // A 的 attempt 未被调用
  })

  it('excludeMembers 与行上持久化 options.exclude 取并集', async () => {
    behaviors['s1'] = async () => [{ ok: 1 }]
    behaviors['s2'] = async () => [{ ok: 2 }]
    behaviors['s3'] = async () => [{ ok: 3 }]
    putProvider({
      id: 'llmtri', category: 'llm', strategy: 'sequential',
      members: [{ source: 's1' }, { source: 's2' }, { source: 's3' }],
      options: { exclude: ['s1'] },
    })
    const r = (await exec.invoke('llmtri', 'q', { excludeMembers: ['s2'] }))!
    expect(r).toMatchObject({ via: 's3' })
    expect(fetched.map((f) => f.sourceId)).toEqual(['s3'])
  })

  it('collect() 同样接受 excludeMembers', async () => {
    behaviors['s1'] = async () => [{ ok: 1 }]
    behaviors['s2'] = async () => [{ ok: 2 }]
    putProvider({
      // collect 只有全收（并发）语义的行支持，所以这里必须是 concurrent。
      id: 'llmcol', category: 'llm', strategy: 'concurrent',
      members: [{ source: 's1' }, { source: 's2' }],
    })
    const r = (await exec.collect('llmcol', 'q', { excludeMembers: ['s1'] }))!
    expect(r.results.map((x) => x.member)).toEqual(['s2'])
    expect(fetched.map((f) => f.sourceId)).toEqual(['s2'])
  })

  it('不传 excludeMembers 时语义逐字节不变', async () => {
    behaviors['s1'] = async () => [{ ok: 1 }]
    putProvider({ id: 'llmplain', category: 'llm', strategy: 'sequential', members: [{ source: 's1' }] })
    const r = (await exec.invoke('llmplain', 'q'))!
    expect(r).toMatchObject({ via: 's1' })
  })
})
