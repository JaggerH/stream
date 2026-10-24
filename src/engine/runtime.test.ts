import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { createRuntime, createStream, type Stream } from './index.ts'
import { readConfig } from '../bootstrap.ts'
import { createExitHooks } from '../exit-hooks.ts'
import { acquireFacilityLock } from '../replay/author/facility-lock.ts'
import type { RssHubAdapter } from '../rsshub-adapter.ts'

function tempRoot(): { root: string; config: ReturnType<typeof readConfig> } {
  const root = mkdtempSync(join(tmpdir(), 'stream-runtime-'))
  mkdirSync(join(root, 'packages'))
  const config = { ...readConfig(join(root, 'config.yaml'), { STREAM_DATA_DIR: root }), packages_dir: join(root, 'packages'), rsshub_catalog: '' }
  return { root, config }
}

const roots: string[] = []
const open: Stream[] = []
afterEach(async () => {
  for (const s of open.splice(0)) await s.close()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
const make = async (runtime?: ReturnType<typeof createRuntime>) => {
  const { root, config } = tempRoot(); roots.push(root)
  const s = await createStream({ dataDir: root, config, log: () => {}, ...(runtime ? { runtime } : {}) })
  open.push(s)
  return s
}
const rsshubOf = (s: Stream) => (s.kernel.adapters.get('rsshub') as RssHubAdapter).worker

describe('StreamRuntime', () => {
  it('库档不碰进程：不挂 unhandledRejection / uncaughtException、不换全局 fetch', async () => {
    const before = [process.listenerCount('unhandledRejection'), process.listenerCount('uncaughtException')]
    const f = globalThis.fetch
    const rt = createRuntime()
    const s = await make(rt)
    expect([process.listenerCount('unhandledRejection'), process.listenerCount('uncaughtException')]).toEqual(before)
    expect(globalThis.fetch).toBe(f)
    await s.close()
    await rt.close()
  })

  it('两个实例共用一个 runtime：用的是同一个 RSSHub worker；关掉一个，worker 还是 runtime 的', async () => {
    const rt = createRuntime()
    const a = await make(rt)
    const b = await make(rt)
    expect(rsshubOf(a)).toBe(rt.rsshub)
    expect(rsshubOf(b)).toBe(rt.rsshub)
    await a.close()
    // 不是 A 的 runtime（调用方建的），A 关时不该收它
    expect(b.runtime).toBe(rt)
    await rt.close()
  })

  it('不传 runtime：各自建一份（各一个 worker），关实例时一起关', async () => {
    const a = await make()
    const b = await make()
    expect(rsshubOf(a)).not.toBe(rsshubOf(b))
    expect(rsshubOf(a)).toBe(a.runtime.rsshub)
  })

  it('退出收尾：runtime 关时把登记的 facility 锁文件删掉（库档不靠进程信号）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stream-locks-')); roots.push(dir)
    const rt = createRuntime()
    await acquireFacilityLock(dir, 'site', rt.exitHooks)
    expect(existsSync(join(dir, 'site.lock'))).toBe(true)
    await rt.close()
    expect(existsSync(join(dir, 'site.lock'))).toBe(false)
  })

  it('兜底网的通知发给挂着的实例；撤了就不再收', () => {
    const rt = createRuntime()
    const got: string[] = []
    const off = rt.attachNotify((e) => got.push(e.type))
    off()
    expect(got).toEqual([])
  })
})

describe('createExitHooks', () => {
  it('挂在进程上：第一次登记才挂信号；信号到了跑一遍且只跑一遍', () => {
    const fake = new EventEmitter()
    const hooks = createExitHooks(fake as never)
    expect(fake.listenerCount('SIGTERM')).toBe(0)
    let n = 0
    hooks.add(() => { n += 1 })
    expect(fake.listenerCount('SIGTERM')).toBe(1)
    fake.emit('SIGTERM')
    fake.emit('exit')
    expect(n).toBe(1)
  })

  it('撤掉的不跑；一个抛错不拖住其余', () => {
    const hooks = createExitHooks()
    const ran: string[] = []
    const off = hooks.add(() => ran.push('a'))
    hooks.add(() => { throw new Error('x') })
    hooks.add(() => ran.push('c'))
    off()
    hooks.runAll()
    expect(ran).toEqual(['c'])
  })
})
