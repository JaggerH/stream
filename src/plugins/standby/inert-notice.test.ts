import { describe, expect, it } from 'vitest'
import { standbyInertNotification } from './inert-notice.ts'

/**
 * 开机那一刻就发现「够不着 Docker」——这是这条链路上最早能说话的地方，比等到有人真去用
 * 某个插件早几个小时。而在 2026-09-02 之前它只有一行 `console.log`。
 *
 * 边界（比"发得出来"更要紧）：inert 有三条出口，只有这一条是事故。另外两条天天发生在
 * 桌面档和没装 Docker 的机器上，喊了就是训练用户忽略这个铃铛。
 */
describe('standbyInertNotification', () => {
  it('够不着 Docker → 一条通知，说清影响面和该干嘛', () => {
    const n = standbyInertNotification({
      manager: null, inertReason: 'docker-unreachable', affected: ['pansou', 'alist', 'voiceprint'],
    })!
    expect(n.severity).toBe('error')
    expect(n.title).toMatch(/Docker/)
    // 影响面要报出来：用户看到的症状只是"某个插件不好使"，看不出是全体一起没了。
    expect(n.body).toContain('3')
    expect(n.detail).toContain('pansou')
    expect(n.detail).toContain('alist')
    // 用户读的那几行里不许出现内部术语。
    expect(`${n.title}${n.body}`).not.toMatch(/standby|inert|docker-unreachable|wireStandby/)
  })

  it('和取址那侧共用一个去重键 —— 同一件事只占一行', () => {
    // 开机时喊过一次，之后有人真去用插件时又撞上，两条说的是同一件事。
    const n = standbyInertNotification({ manager: null, inertReason: 'docker-unreachable', affected: ['pansou'] })!
    expect(n.dedupeKey).toBe('plugin-target:docker-unreachable')
  })

  it('按设计如此的两条 inert → 不喊（桌面档 / 没插件声明 standby 天天如此）', () => {
    for (const inertReason of ['not-gated', 'no-resolvable-services'] as const) {
      expect(standbyInertNotification({ manager: null, inertReason })).toBeNull()
    }
  })

  it('接线成功 → 不喊', () => {
    // manager 在就没什么可说的，哪怕字段里还残留着一个原因。
    expect(standbyInertNotification({ manager: {} as never })).toBeNull()
    expect(standbyInertNotification({ manager: {} as never, inertReason: 'docker-unreachable' })).toBeNull()
  })

  it('一个受影响的 service 都没有 → 不喊（没有影响面就没有要告诉用户的事）', () => {
    expect(standbyInertNotification({ manager: null, inertReason: 'docker-unreachable', affected: [] })).toBeNull()
    expect(standbyInertNotification({ manager: null, inertReason: 'docker-unreachable' })).toBeNull()
  })
})
