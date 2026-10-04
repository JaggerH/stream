import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DESKTOP_CAPABILITY_NAME, hostAgentSkipReason, mountHostAgent } from './mount.ts'
import { createCapabilityHost } from '../capabilities/host.ts'

describe('hostAgentSkipReason', () => {
  it('默认（非测试进程）就养', () => {
    expect(hostAgentSkipReason({})).toBeUndefined()
  })
  it('STREAM_NO_DESKTOP=1 / 查询档 / vitest 三种都不养，并各自说清理由', () => {
    expect(hostAgentSkipReason({ STREAM_NO_DESKTOP: '1' })).toMatch(/STREAM_NO_DESKTOP/)
    // 「旧名没留别名」由 src/capability-names.guard.test.ts 的 LEGACY_AGENT_NAME 证明——
    // 它证的是"整个仓库里搜不到旧名"，比在这里喂一次旧名更强，所以这条不在这儿重复。
    expect(hostAgentSkipReason({ STREAM_NO_SCHEDULER: '1' })).toMatch(/查询档/)
    expect(hostAgentSkipReason({ VITEST: 'true' })).toMatch(/测试/)
  })
})

describe('Stream Desktop 走的是那一份共享宿主', () => {
  // 后端把自己翻译成 CapabilityContext 的实现只有一份（src/capabilities/host.ts）。这条钉的是
  // 「agent 这半确实经过它」：日志前缀由能力名派生，另起一份实现就对不上了。
  it('日志前缀由能力名派生；收摊登记进宿主', async () => {
    const lines: string[] = []
    const host = createCapabilityHost({ dataDir: mkdtempSync(join(tmpdir(), 'ha-')), log: (m) => lines.push(m) })
    const order: string[] = []
    await mountHostAgent(
      { host, baseUrl: 'http://x', dataDir: '/d', extensionId: 'e', log: (m) => lines.push(m) },
      async (ctx) => {
        ctx.log.info('hi')
        ctx.onDispose(() => { order.push('agent') })
      },
    )
    expect(lines).toContain(`[stream-${DESKTOP_CAPABILITY_NAME}] hi`)
    await host.dispose()
    expect(order).toEqual(['agent'])
  })
})

describe('mountHostAgent', () => {
  it('把后端的门、data 根、扩展 id 原样递给 Stream Desktop；收摊逆序跑登记的 disposer', async () => {
    let got: unknown
    const order: string[] = []
    const dispose = await mountHostAgent(
      { baseUrl: 'http://127.0.0.1:8900', dataDir: '/home/u/.stream', extensionId: 'abc', log: () => {} },
      async (ctx, config) => {
        got = config
        ctx.onDispose(() => { order.push('first') })
        ctx.onDispose(() => { order.push('second') })
      },
    )
    expect(got).toEqual({ streamBaseUrl: 'http://127.0.0.1:8900', streamDataDir: '/home/u/.stream', extensionId: 'abc' })
    await dispose()
    expect(order).toEqual(['second', 'first'])
  })

  it('mount 抛了只记 warn，后端照常拿到一个收摊函数', async () => {
    const lines: string[] = []
    const dispose = await mountHostAgent(
      { baseUrl: 'http://x', dataDir: '/d', extensionId: 'e', log: (m) => lines.push(m) },
      async () => { throw new Error('boom') },
    )
    expect(lines.join('\n')).toMatch(/mount 失败.*boom/)
    await expect(dispose()).resolves.toBeUndefined()
  })
})

// 平台包名 `@streamapp/desktop-<平台>` 是 npm 上的包名（线上常量）——两处 pin 分家的表现是
// 发行安装解不到 exe，"装好了但永远配不上"。
describe('发行包带着 stream-desktop 平台包', () => {
  // 后端自己养它的前提是发行安装里解得到那个 exe：cli 的 optionalDependencies 必须和
  // capabilities/desktop 引的同一个版本——两处分家的表现是"开发机能配对、用户机器永远 never-seen"。
  it('cli/package.json 的 optionalDependencies 与 capabilities/desktop 引同一个版本', () => {
    const root = resolve(import.meta.dirname, '../..')
    const read = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8')) as { optionalDependencies?: Record<string, string> }
    const cli = read('cli/package.json').optionalDependencies ?? {}
    const desktop = read('capabilities/desktop/package.json').optionalDependencies ?? {}
    for (const [name, version] of Object.entries(desktop)) {
      expect(cli[name], `${name} 不在 cli/package.json 的 optionalDependencies 里——发行安装上后端解不到 agent`).toBe(version)
    }
  })
})
