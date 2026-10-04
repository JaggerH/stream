import { describe, expect, it } from 'vitest'
import type { AlistStorage } from '../../shared/netdisk/alist-client.ts'
import type { BrowserCookie } from '../../src/types.ts'
import { reconcileMounts, mountStatusOf, type MountEntry, type StorageAdmin } from './mounts.ts'

/** 内存版 StorageAdmin：行为对齐 AList（create 即 enabled；update 原样覆盖）。 */
function memoryAdmin(seed: AlistStorage[] = []) {
  const storages = seed.map((s) => ({ ...s }))
  let nextId = Math.max(0, ...storages.map((s) => s.id)) + 1
  const calls: string[] = []
  const admin: StorageAdmin = {
    async listStorages() {
      calls.push('list')
      return storages.map((s) => ({ ...s }))
    },
    async createStorage(s) {
      calls.push(`create:${s.mount_path}`)
      storages.push({ id: nextId++, disabled: false, ...s })
    },
    async updateStorage(s) {
      calls.push(`update:${s.mount_path}`)
      const i = storages.findIndex((x) => x.id === s.id)
      storages[i] = { ...s }
    },
    async enableStorage(id) {
      calls.push(`enable:${id}`)
      const hit = storages.find((x) => x.id === id)
      if (hit) hit.disabled = false
    },
  }
  return { admin, storages, calls }
}

const cookie = (name: string, value: string): BrowserCookie => ({ name, value }) as BrowserCookie

const cookies115 = { '115.com': [cookie('UID', 'u1'), cookie('CID', 'c1')] }
const desired: MountEntry[] = [{ presetId: '115' }]

describe('reconcileMounts', () => {
  it('缺 → create，且连跑两遍第二遍零变更（幂等）', async () => {
    const { admin, storages, calls } = memoryAdmin()
    const r1 = await reconcileMounts(desired, admin, async () => cookies115)
    expect(r1.created).toEqual(['/115'])
    expect(storages).toHaveLength(1)
    expect(storages[0].driver).toBe('115 Cloud')
    expect(JSON.parse(storages[0].addition)).toMatchObject({ cookie: 'UID=u1; CID=c1' })

    calls.length = 0
    const r2 = await reconcileMounts(desired, admin, async () => cookies115)
    expect(r2).toEqual({ created: [], healed: [], missingCookie: [], ok: ['/115'] })
    expect(calls).toEqual(['list']) // 第二遍只读不写
  })

  it('disabled → 拉新 cookie update + enable（自愈）', async () => {
    const { admin, storages, calls } = memoryAdmin([
      { id: 7, mount_path: '/115', driver: '115 Cloud', addition: '{"cookie":"UID=stale"}', disabled: true },
    ])
    const r = await reconcileMounts(desired, admin, async () => cookies115)
    expect(r.healed).toEqual(['/115'])
    expect(storages[0].disabled).toBe(false)
    expect(JSON.parse(storages[0].addition).cookie).toBe('UID=u1; CID=c1')
    expect(calls).toEqual(['list', 'update:/115', 'enable:7'])
  })

  it('快照里无该域 cookie → missingCookie，不建不抛', async () => {
    const { admin, storages } = memoryAdmin()
    const r = await reconcileMounts(desired, admin, async () => ({}))
    expect(r.missingCookie).toEqual(['/115'])
    expect(storages).toHaveLength(0)
  })

  it('前缀点域名变体（.115.com）也能命中', async () => {
    const { admin } = memoryAdmin()
    const r = await reconcileMounts(desired, admin, async () => ({ '.115.com': [cookie('UID', 'u1')] }))
    expect(r.created).toEqual(['/115'])
  })

  it('不认识的 storage 不动；期望态为空不读快照', async () => {
    const foreign: AlistStorage = { id: 1, mount_path: '/manual', driver: 'Local', addition: '{}', disabled: false }
    const { admin, storages } = memoryAdmin([foreign])
    let cookieFetched = false
    const r = await reconcileMounts([], admin, async () => {
      cookieFetched = true
      return {}
    })
    expect(r).toEqual({ created: [], healed: [], missingCookie: [], ok: [] })
    expect(storages[0]).toEqual(foreign)
    expect(cookieFetched).toBe(false)
  })
})

const storage = (over: Partial<AlistStorage> = {}): AlistStorage =>
  ({ id: 1, mount_path: '/quark', driver: 'Quark', addition: '{}', disabled: false, ...over })

describe('mountStatusOf', () => {
  it('有 storage、未禁用、状态 work/空 → mounted', () => {
    expect(mountStatusOf(storage({ status: 'work' }), true)).toBe('mounted')
    expect(mountStatusOf(storage({ status: undefined }), false)).toBe('mounted')
  })
  it('有 storage 但被禁用或状态异常 → error', () => {
    expect(mountStatusOf(storage({ disabled: true }), true)).toBe('error')
    expect(mountStatusOf(storage({ status: 'please login' }), true)).toBe('error')
  })
  it('无 storage：有 cookie → cookieReady，无 cookie → noCookie', () => {
    expect(mountStatusOf(undefined, true)).toBe('cookieReady')
    expect(mountStatusOf(undefined, false)).toBe('noCookie')
  })
})
