/**
 * sidequest 面板（退回 R2）：**面板不随实例 / `tasks.start` 起**——它是 HTTP 面，`routes()`
 * 经 `tasks.startDashboard(port)` 起，只绑 `127.0.0.1`。
 *
 * 原状是 `tasks.start(…, { dashboardPort })` 里顺手起、绑全部网卡：同进程第二个实例必然撞口
 * （当时被当成「环境噪音」的那行 dashboard 绑定失败就是它）。这里钉住三件事：
 * 不经 `startDashboard` 就没有端口；起了只认回环（IPv4 通、IPv6 回环拒）；端口被占不掀翻装配。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskCenter } from './center.ts'

const centers: TaskCenter[] = []
const roots: string[] = []
afterEach(async () => {
  for (const c of centers.splice(0)) await c.stop().catch(() => {})
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

const make = async () => {
  const root = mkdtempSync(join(tmpdir(), 'center-dash-'))
  roots.push(root)
  const c = new TaskCenter()
  centers.push(c)
  await c.start([], { dbPath: join(root, 'sidequest.sqlite'), log: () => {}, watchdog: false })
  return c
}

const probe = async (url: string): Promise<number | 'refused'> => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) })
    await r.arrayBuffer().catch(() => {})
    return r.status
  } catch {
    return 'refused'
  }
}

describe('sidequest 面板（startDashboard）', () => {
  it('起在给定的口、只绑本机回环（IPv4 回环可达，IPv6 回环拒）', async () => {
    const c = await make()
    const port = 30000 + Math.floor(Math.random() * 9000)
    await c.startDashboard(port, () => {})
    const v4 = await probe(`http://127.0.0.1:${port}/_p/sidequest/`)
    expect(v4, 'IPv4 回环应该有 HTTP 响应（哪怕 404）').not.toBe('refused')
    const v6 = await probe(`http://[::1]:${port}/_p/sidequest/`)
    expect(v6, '面板只绑 127.0.0.1——IPv6 回环必须连不上').toBe('refused')
  })

  it('端口被占：第二个只降级（不抛、不掀翻），第一个照常服务', async () => {
    const port = 30000 + Math.floor(Math.random() * 9000)
    const first = await make()
    await first.startDashboard(port, () => {})
    const second = await make()
    await expect(second.startDashboard(port, () => {})).resolves.toBeUndefined()
    const still = await probe(`http://127.0.0.1:${port}/_p/sidequest/`)
    expect(still).not.toBe('refused')
  })

  it('调度中心没起 / 门面不支持：只留一行日志，不抛', async () => {
    const idle = new TaskCenter()
    await expect(idle.startDashboard(39999)).resolves.toBeUndefined()
    // 假门面（与 center.dynamic.test.ts 同款）没有 startDashboard 这一格 → 同样只降级。
    const fake = new TaskCenter()
    centers.push(fake)
    await fake.start([], {
      dbPath: join(mkdtempSync(join(tmpdir(), 'center-dash-fake-')), 'sq.sqlite'),
      log: () => {}, watchdog: false,
      sidequest: { start: async () => undefined, stop: async () => undefined, build: () => ({}) } as never,
      jobClass: class {},
    })
    await expect(fake.startDashboard(39999)).resolves.toBeUndefined()
  })
})
