// 这一次读哪份登录态（browser-identity D10）：与浏览器命令同一个节点。
import { describe, expect, it } from 'vitest'
import { cookieSlot, currentCookieSlot, parseCookieSlot } from './cookie-slot.ts'
import { runOnDevice } from '../devices/run-context.ts'
import { DeviceIncapable, DeviceOffline } from '../devices/errors.ts'

const isNode = (id: string) => (id.startsWith('local:') ? id.slice(6) : id === 'ext:n' ? 'node_n' : undefined)

function browsers(online: string[], pickOrder: string[] = online) {
  const live = new Set(online)
  return {
    pick: (dev: string) => {
      if (dev === 'local') return pickOrder.find((b) => live.has(b) && b.startsWith('local')) ?? 'local'
      if (dev === 'linux:bare') throw new DeviceIncapable(dev, 'browser')
      const hit = pickOrder.find((b) => live.has(b) && !b.startsWith('local'))
      if (!hit) throw new DeviceOffline(dev)
      return hit
    },
    isOnline: (id: string) => live.has(id),
    deviceOf: (id: string) => (id.startsWith('local') ? 'local' : 'linux:nas'),
    nodeOf: isNode,
    add: (id: string) => live.add(id),
  }
}

const nodes = (rows: Record<string, Array<{ nodeId: string; isDefault?: boolean; lastSeenAt: number }>>) => ({
  forDevice: (dev: string) => (rows[dev] ?? []).map((r) => ({ isDefault: false, ...r })),
})

describe('cookieSlot', () => {
  it('节点槽位与设备槽位互相拆得回来；设备 id 自带冒号也不乱', () => {
    expect(cookieSlot('local', 'node_a')).toBe('local/node_a')
    expect(parseCookieSlot('linux:nas/node_a')).toEqual({ deviceId: 'linux:nas', nodeId: 'node_a' })
    expect(parseCookieSlot('linux:nas')).toEqual({ deviceId: 'linux:nas' })
    expect(parseCookieSlot('local/../x')).toEqual({ deviceId: 'local/../x' })
  })
})

describe('currentCookieSlot', () => {
  it('执行外 = 本机此刻的默认节点', () => {
    expect(currentCookieSlot(browsers(['local:node_w']))).toBe('local/node_w')
  })

  it('只有老扩展（兼容槽）在线 = 升级前那份 local', () => {
    expect(currentCookieSlot(browsers(['local']))).toBe('local')
  })

  it('【核心】执行内钉住第一次选中的节点：中途连上的 profile 不改变读哪份', async () => {
    const b = browsers(['local:node_w'], ['local:node_p', 'local:node_w'])
    await runOnDevice({ deviceId: 'local', allowHosts: [] }, async () => {
      expect(currentCookieSlot(b)).toBe('local/node_w')
      b.add('local:node_p') // 更「合适」的那个连上了
      expect(currentCookieSlot(b)).toBe('local/node_w')
    })
  })

  it('本机节点全离线：读默认节点，再退到最近见过的；不读兼容槽的旧文件', () => {
    const none = browsers([])
    expect(currentCookieSlot(none, nodes({ local: [{ nodeId: 'node_w', lastSeenAt: 1 }, { nodeId: 'node_p', lastSeenAt: 5 }] }))).toBe('local/node_p')
    expect(currentCookieSlot(none, nodes({ local: [{ nodeId: 'node_w', lastSeenAt: 1, isDefault: true }, { nodeId: 'node_p', lastSeenAt: 5 }] }))).toBe('local/node_w')
    expect(currentCookieSlot(none, nodes({}))).toBe('local')
  })

  it('远程设备：在线的节点 → 它；都离线 → 最近见过的节点；没有浏览器（只有 http.fetch）→ 设备那份', async () => {
    await runOnDevice({ deviceId: 'linux:nas', allowHosts: [] }, async () => {
      expect(currentCookieSlot(browsers(['ext:n']))).toBe('linux:nas/node_n')
    })
    await runOnDevice({ deviceId: 'linux:nas', allowHosts: [] }, async () => {
      expect(currentCookieSlot(browsers([]), nodes({ 'linux:nas': [{ nodeId: 'node_n', lastSeenAt: 3 }] }))).toBe('linux:nas/node_n')
    })
    await runOnDevice({ deviceId: 'linux:bare', allowHosts: [] }, async () => {
      expect(currentCookieSlot(browsers([]))).toBe('linux:bare')
    })
  })

  it('远程设备上的老扩展绑定（没有节点）= 设备那份', async () => {
    await runOnDevice({ deviceId: 'linux:nas', allowHosts: [] }, async () => {
      expect(currentCookieSlot(browsers(['ext:a']))).toBe('linux:nas')
    })
  })
})
