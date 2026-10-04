import { describe, it, expect, vi } from 'vitest'
import { NetdiskShareCapability } from './share-capability.ts'
import type { ProviderExecutor } from '../providers/executor.ts'
import { ProviderDirectory } from '../providers/directory.ts'
import { ProviderBindings } from '../providers/bindings.ts'
import { SYSTEM_IDENTITIES } from '../providers/system/index.ts'
import { UserStore } from '../store/user-store.ts'

const row = (id: string, serves: string[]) => ({ id, serves }) as any

/** 守门测的就是选行判据本身，所以这里给**真的** `ProviderDirectory`（不是手搓 stub）：
 *  stub 一旦和 directory 的两档语义漂移，这些用例就会在错误的东西上变绿。 */
const directoryOf = (rows: any[]): ProviderDirectory => {
  const store = new UserStore(':memory:')
  for (const r of rows) {
    store.putProvider({ id: r.id, label: r.id, description: '', category: 'resolve', serves: r.serves, strategy: 'sequential', members: [], contract: null, options: r.options ?? {} })
  }
  return new ProviderDirectory(store, SYSTEM_IDENTITIES)
}

/** `rows` 是选行看得见的行；`value` 是 invoke() 的返回。
 *  成员是 object 型（manifest.output='object'），执行器缝上已解包——value 直接是判决/结果对象。 */
const cap = (rows: any[], invoke = vi.fn(async () => null as any)) =>
  new NetdiskShareCapability({
    executor: { invoke } as unknown as ProviderExecutor,
    directory: directoryOf(rows),
  })

const seq = (value: unknown, misses: { member: string; reason: string; stack?: string }[] = []) =>
  ({ strategy: 'sequential', provider: 'p', value, via: 'm', misses, timings: [] }) as any

describe('NetdiskShareCapability — fall-through guard', () => {
  // 无具名命中时选行会落到同 category 的兜底行。把一条分享 id 递给一个通用兜底行，拿回的是
  // 语义无意义的「结果」而不是诚实的「不支持」——这道守门就是这个类存在的理由。
  it('refuses the fallback row: an unsupported netdisk is null, not a fallback row', async () => {
    const invoke = vi.fn(async () => seq({ validity: 'alive', files: [] }))
    const c = cap([row('fetch-url', ['*'])], invoke)
    expect(await c.verify('baidu', 'abc')).toBeNull()
    expect(await c.save('baidu', 'abc')).toBeNull()
    expect(c.supports('baidu', 'verify')).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('accepts a row that explicitly serves the key', async () => {
    const c = cap([row('netdisk-verify-quark', ['quark-verify'])])
    expect(c.supports('quark', 'verify')).toBe(true)
  })

  it('prefers an explicit user binding over match()', async () => {
    const invoke = vi.fn(async () => seq({ validity: 'unknown', files: [] }))
    const c = new NetdiskShareCapability({
      executor: { invoke } as unknown as ProviderExecutor,
      directory: directoryOf([row('netdisk-verify-quark', ['quark-verify'])]),
      bindings: { dispatch: () => 'user-picked-row' } as any,
    })
    await c.verify('quark', 'abc')
    expect(invoke).toHaveBeenCalledWith('user-picked-row', 'abc', undefined)
  })

  // 绑定那一路曾经是个后门：`match()` 挡住了兜底行，`dispatch()` 没挡——把一条兜底行绑到
  // 这个调用点，不支持的网盘就会从背后被判成「支持」。两条路现在都传 fallback:false。
  it('绑定里只有兜底行 → 仍然是「不支持」，不从 binding 那一路绕进来', () => {
    const store = new UserStore(':memory:')
    store.putProvider({ id: 'fetch-url', label: '', description: '', category: 'resolve', serves: ['*'], strategy: 'sequential', members: [], contract: null, options: {} })
    store.putProviderBinding({ callsiteId: 'netdisk.share.verify', providerIds: ['fetch-url'] })
    const directory = new ProviderDirectory(store, SYSTEM_IDENTITIES)
    const c = new NetdiskShareCapability({
      executor: { invoke: vi.fn() } as unknown as ProviderExecutor,
      directory,
      bindings: new ProviderBindings(store, directory),
    })
    expect(c.supports('baidu', 'verify')).toBe(false)
    store.close()
  })

  // 百度几乎每条分享都锁着提取码——不带上它，验活只能答出「链接存在」，最有价值的文件名全丢。
  it('passes a passcode through as a per-call override', async () => {
    const invoke = vi.fn(async () => seq({ validity: 'unknown', files: [] }))
    const c = cap([row('netdisk-verify-baidu', ['baidu-verify'])], invoke)
    await c.verify('baidu', 'p1', { passcode: '1111' })
    expect(invoke).toHaveBeenCalledWith('netdisk-verify-baidu', 'p1', { overrides: { passcode: '1111' } })
  })
})

describe('NetdiskShareCapability.verify', () => {
  const rows = [row('netdisk-verify-quark', ['quark-verify'])]

  it('判决对象直达：alive + 文件名（选题信号）', async () => {
    const invoke = vi.fn(async () => seq({ validity: 'alive', files: [{ name: '黄 粱 一 梦', is_dir: true, size: 0 }] }))
    expect(await cap(rows, invoke).verify('quark', 'p1')).toEqual({
      validity: 'alive',
      files: [{ name: '黄 粱 一 梦', is_dir: true, size: 0 }],
    })
  })

  // 「看不进去 ≠ 死」是探针语义三分的核心（spec §5.4）：锁着的百度分享无码/错码时成员答
  // unknown，照搬——把它判死会让一条活链静悄悄消失（死链默认隐藏）。
  it('照搬成员的 unknown 判决——看不进去不等于死', async () => {
    const invoke = vi.fn(async () => seq({ validity: 'unknown', files: [] }))
    expect(await cap(rows, invoke).verify('quark', 'p1')).toEqual({ validity: 'unknown', files: [] })
  })

  it('判决对象缺 validity 时按 unknown 算——判决说不清就不替这条链下结论', async () => {
    const invoke = vi.fn(async () => seq({ files: [] }))
    expect(await cap(rows, invoke).verify('quark', 'p1')).toEqual({ validity: 'unknown', files: [] })
  })

  it('distinguishes a login wall from a dead link', async () => {
    const invoke = vi.fn(async () => seq(null, [{ member: 'quark-share', reason: 'NeedsLoginError: quark-share' }]))
    expect(await cap(rows, invoke).verify('quark', 'p1')).toEqual({ validity: 'needs-login', files: [] })
  })

  // 弃权 vs 抛错,是 executor 用 miss 上有没有 stack 表达的（InvokeMiss.stack:「undefined for
  // non-error misses」）。这两件事必须分开：
  //  - 弃权(无 stack) = attempt 返回 null（object 成员 decode 主动弃权）= 这条分享里没东西 = 死链
  //  - 抛错(有 stack) = 我们没查成，对这条链一无所知 = unknown
  it('弃权的成员(无 stack)是 not-usable —— recipe 跑通了但没收获 = 分享死了', async () => {
    const invoke = vi.fn(async () => seq(null, [{ member: 'quark-share', reason: 'declined (no result)' }]))
    expect(await cap(rows, invoke).verify('quark', 'p1')).toEqual({ validity: 'not-usable', files: [] })
  })

  // 「我们没查成」不是「链接死了」。成员抛错(网络故障 / 上游 5xx / body 不是 JSON)时我们对这条
  // 链一无所知——把它说成已失效,和前端拒绝把 501 显示成「已失效」是同一条原则,只是低一层。
  // 死链默认隐藏,所以这个谎会让一条活链静悄悄消失。
  it('抛错的成员(有 stack)是 unknown —— 没查成不等于链接死了', async () => {
    const invoke = vi.fn(async () =>
      seq(null, [{ member: 'quark-share', reason: 'FetchError: socket hang up', stack: 'Error: socket hang up\n  at x' }]),
    )
    expect(await cap(rows, invoke).verify('quark', 'p1')).toEqual({ validity: 'unknown', files: [] })
  })

  it('抛错和弃权混在一起时按 unknown 算 —— 有人没查成就不该替这条链下判决', async () => {
    const invoke = vi.fn(async () =>
      seq(null, [
        { member: 'a', reason: 'declined (no result)' },
        { member: 'b', reason: 'boom', stack: 'Error: boom\n  at y' },
      ]),
    )
    expect(await cap(rows, invoke).verify('quark', 'p1')).toEqual({ validity: 'unknown', files: [] })
  })
})

describe('NetdiskShareCapability.save', () => {
  const rows = [row('netdisk-save-quark', ['quark-save'])]

  it('unwraps a successful transfer', async () => {
    const invoke = vi.fn(async () => seq({ saved: true, stage: 'done', message: '分享-转存', dest: 'From Stream', file_count: 1 }))
    expect(await cap(rows, invoke).save('quark', 'p1')).toEqual({
      saved: true, stage: 'done', message: '分享-转存', dest: 'From Stream', file_count: 1,
    })
  })

  it('surfaces the stage a failed transfer stopped at', async () => {
    const invoke = vi.fn(async () => seq({ saved: false, stage: 'dest', message: 'destination folder not found: From Stream' }))
    const r = await cap(rows, invoke).save('quark', 'p1')
    expect(r).toMatchObject({ saved: false, stage: 'dest' })
  })

  it('passes a per-call dest override through to the member', async () => {
    const invoke = vi.fn(async () => seq({ saved: true, stage: 'done' }))
    await cap(rows, invoke).save('quark', 'p1', { dest: 'Inbox' })
    expect(invoke).toHaveBeenCalledWith('netdisk-save-quark', 'p1', { overrides: { dest: 'Inbox' } })
  })

  it('sends no overrides when the caller specifies none (the row default wins)', async () => {
    const invoke = vi.fn(async () => seq({ saved: true, stage: 'done' }))
    await cap(rows, invoke).save('quark', 'p1')
    expect(invoke).toHaveBeenCalledWith('netdisk-save-quark', 'p1', undefined)
  })

  it('reports the misses when no member produced a value', async () => {
    const invoke = vi.fn(async () => seq(null, [{ member: 'quark-save', reason: 'boom' }]))
    expect(await cap(rows, invoke).save('quark', 'p1')).toMatchObject({ saved: false, stage: 'invoke', message: 'boom' })
  })
})
