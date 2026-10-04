import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, quiesceKernel } from '../context.ts'
import { eventsPlugin } from './events.ts'

async function mount() {
  const root = mkdtempSync(join(tmpdir(), 'stream-events-'))
  const path = join(root, 'events.json')
  const frames: unknown[] = []
  const kernel = createKernel()
  await kernel.plugin(eventsPlugin, { path, broadcast: (m) => void frames.push(m) })
  return { kernel, path, frames }
}

describe('eventsPlugin', () => {
  it('挂成 ctx.streamEvents：emit 落盘 + 推一帧；dispose 后消失', async () => {
    const { kernel, path, frames } = await mount()
    kernel.streamEvents.emit({ type: 'harvest.error', severity: 'error', title: '采集失败：x' })
    expect(kernel.streamEvents.list()).toHaveLength(1)
    expect(frames).toHaveLength(1)
    expect(existsSync(path)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8')).events).toHaveLength(1)
    await quiesceKernel(kernel)
    expect(kernel.streamEvents).toBeUndefined()
  })

  // 去重语义随服务一起搬过来，不该在搬家途中变形。
  it('同 dedupeKey 的未读事件原地刷新，不堆第二行', async () => {
    const { kernel, frames } = await mount()
    kernel.streamEvents.emit({ type: 'auth.needed', severity: 'warn', title: 'a', dedupeKey: 'auth:xhs' })
    kernel.streamEvents.emit({ type: 'auth.needed', severity: 'warn', title: 'a', dedupeKey: 'auth:xhs' })
    expect(kernel.streamEvents.list()).toHaveLength(1)
    expect((frames[1] as { refreshed?: boolean }).refreshed).toBe(true)
    await quiesceKernel(kernel)
  })

  /**
   * 这条钉的是**键名本身**，不是行为：`ctx.events` 是 cordis 本体的服务，`provide('events', …)`
   * 静默无效（不抛、不覆盖）。而上游那个服务也有 `emit`——真挂错了名字，通知中心会一条不落地
   * 全部发进上游总线，零报错。所以「我们的服务不叫 events」得有一条测试守着。
   */
  it('ctx.events 仍是 cordis 本体的服务——我们的门在 streamEvents 上', async () => {
    const { kernel } = await mount()
    expect(kernel.events).toBeDefined()
    expect(kernel.events).not.toBe(kernel.streamEvents)
    expect((kernel.events as unknown as { list?: unknown }).list).toBeUndefined()
    await quiesceKernel(kernel)
  })
})
