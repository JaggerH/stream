import { describe, it, expect } from 'vitest'
import type { PluginDescriptor } from '../types.ts'
import { planStandbyServices, standbyManagingLabel } from './service-list.ts'

// 这段构造以前 inline 在 serve.ts 的 main() 里,谁都测不到 —— C1(spawn 起在一个端口、探另一个
// 端口)正是靠这种测不到的接缝活过十轮 review 的。这里把它当纯函数钉死。
const plugin = (id: string, backend?: Partial<NonNullable<PluginDescriptor['backend']>>): PluginDescriptor =>
  ({ id, name: id, ...(backend ? { backend: { image: `${id}:latest`, port: 80, ...backend } } : {}) }) as PluginDescriptor

const standby = (idleMinutes: number, startTimeoutSeconds?: number) => ({ standby: { idleMinutes, startTimeoutSeconds } })
const allEnabled = () => true

describe('planStandbyServices — 两道构造闸', () => {
  it('gate 1: no plugin declares backend.standby → not gated, nothing to manage', () => {
    const plan = planStandbyServices({
      descriptors: [plugin('alist', { port: 5244 }), plugin('xhs')],
      mode: 'compose', isEnabled: allEnabled,
    })
    expect(plan).toEqual({ gated: false, services: [], skipped: [], disabled: [] })
  })
  it('gate 2: mode=none (desktop no-door) → not gated even though a plugin declares standby', () => {
    const plan = planStandbyServices({
      descriptors: [plugin('voiceprint', standby(10))],
      mode: 'none', isEnabled: allEnabled,
    })
    expect(plan.gated).toBe(false)
    expect(plan.services).toEqual([])
  })
  it('both gates pass → gated with the declared services', () => {
    const plan = planStandbyServices({
      descriptors: [plugin('voiceprint', { ...standby(10), health: '/health' })],
      mode: 'compose', isEnabled: allEnabled,
      resolveTarget: () => 'http://voiceprint:80',
    })
    expect(plan.gated).toBe(true)
    expect(plan.services.map((s) => s.service)).toEqual(['voiceprint'])
  })
})

describe('planStandbyServices — healthUrl 拼装', () => {
  it('leading-slash path: origin + path verbatim', () => {
    const plan = planStandbyServices({
      descriptors: [plugin('voiceprint', { ...standby(10), health: '/health' })],
      mode: 'compose', isEnabled: allEnabled,
      resolveTarget: () => 'http://voiceprint:80',
    })
    expect(plan.services[0].healthUrl).toBe('http://voiceprint:80/health')
  })
  it('path WITHOUT a leading slash is normalized (loader schema does not enforce one)', () => {
    const plan = planStandbyServices({
      descriptors: [plugin('voiceprint', { ...standby(10), health: 'health' })],
      mode: 'compose', isEnabled: allEnabled,
      resolveTarget: () => 'http://voiceprint:80',
    })
    // 不归一化会拼出 "http://voiceprint:80health" —— fetch 必败,wake 白等满 startTimeout
    expect(plan.services[0].healthUrl).toBe('http://voiceprint:80/health')
  })
  it('no health declared → "/" on the backend-side origin', () => {
    const plan = planStandbyServices({
      descriptors: [plugin('mineru', standby(10))],
      mode: 'compose', isEnabled: allEnabled,
      resolveTarget: () => 'http://mineru:8080',
    })
    expect(plan.services[0].healthUrl).toBe('http://mineru:8080/')
  })
  it('健康 URL 用的是 backend 侧 origin(service 名 + 容器端口),不是客户端的 /_p 路径', () => {
    const plan = planStandbyServices({
      descriptors: [plugin('mineru', { ...standby(30), port: 8000, health: '/ping' })],
      mode: 'compose', isEnabled: allEnabled,
    })
    expect(plan.services[0].healthUrl).toBe('http://mineru:8000/ping')
  })
})

describe('planStandbyServices — 跳过与默认值', () => {
  it('a service whose origin does not resolve is skipped and named', () => {
    const plan = planStandbyServices({
      descriptors: [plugin('voiceprint', standby(10)), plugin('mineru', standby(30))],
      mode: 'compose', isEnabled: allEnabled,
      resolveTarget: (s) => (s === 'mineru' ? null : 'http://voiceprint:80'),
    })
    expect(plan.services.map((s) => s.service)).toEqual(['voiceprint'])
    expect(plan.skipped).toEqual(['mineru'])
  })
  it('all-skipped: gated, but no service to manage (serve logs "inert" and wires nothing)', () => {
    const plan = planStandbyServices({
      descriptors: [plugin('voiceprint', standby(10)), plugin('mineru', standby(30))],
      mode: 'compose', isEnabled: allEnabled,
      resolveTarget: () => null,
    })
    expect(plan.gated).toBe(true)
    expect(plan.services).toEqual([])
    expect(plan.skipped).toEqual(['voiceprint', 'mineru'])
  })
  it('startTimeoutSeconds defaults to 60; an explicit value wins', () => {
    const plan = planStandbyServices({
      descriptors: [plugin('voiceprint', standby(10)), plugin('mineru', standby(30, 120))],
      mode: 'compose', isEnabled: allEnabled,
      resolveTarget: (s) => `http://${s}:80`,
    })
    expect(plan.services.map((s) => s.startTimeoutSeconds)).toEqual([60, 120])
    expect(plan.services.map((s) => s.idleMinutes)).toEqual([10, 30])
  })
})

describe('planStandbyServices — enabled 与别名', () => {
  it('a disabled plugin is still managed, only tagged for the log line', () => {
    const plan = planStandbyServices({
      descriptors: [plugin('voiceprint', standby(10)), plugin('mineru', standby(30))],
      mode: 'compose', isEnabled: (p) => p.id !== 'mineru',
      resolveTarget: (s) => `http://${s}:80`,
    })
    expect(plan.services.map((s) => s.service)).toEqual(['voiceprint', 'mineru'])
    expect(plan.disabled).toEqual(['mineru'])
    expect(standbyManagingLabel(plan)).toBe('voiceprint, mineru (disabled)')
  })
  it('MINOR F: a service name differing from the plugin id gets the id as an alias', () => {
    const plan = planStandbyServices({
      descriptors: [plugin('voiceprint', { ...standby(10), service: 'voiceprint-engine' })],
      mode: 'compose', isEnabled: allEnabled,
      resolveTarget: () => 'http://voiceprint-engine:80',
    })
    // 调用点写死的是 id('voiceprint'),cell 键是 service —— 别名让 withAwake 不会静默 no-op
    expect(plan.services[0].service).toBe('voiceprint-engine')
    expect(plan.services[0].aliases).toEqual(['voiceprint'])
  })
  it('service === id → no alias (今天四个插件都是这种情况)', () => {
    const plan = planStandbyServices({
      descriptors: [plugin('voiceprint', { ...standby(10), service: 'voiceprint' })],
      mode: 'compose', isEnabled: allEnabled,
      resolveTarget: () => 'http://voiceprint:80',
    })
    expect(plan.services[0].aliases).toBeUndefined()
  })
})

describe('host 档 plan', () => {
  const descriptors = [
    {
      id: 'mineru',
      backend: { image: 'x', port: 9000, health: '/health', standby: { idleMinutes: 10 } },
    },
  ] as unknown as PluginDescriptor[]
  it('host 档过闸,产出 hostProbe 而非 healthUrl', () => {
    const plan = planStandbyServices({ descriptors, mode: 'host', isEnabled: () => true })
    expect(plan.gated).toBe(true)
    expect(plan.services).toHaveLength(1)
    expect(plan.services[0].healthUrl).toBeUndefined()
    expect(plan.services[0].hostProbe).toEqual({ containerPort: 9000, healthPath: '/health' })
  })
  it('host 档 health 无前导斜杠同样归一化', () => {
    const d = [
      { id: 'p', backend: { image: 'x', port: 8080, health: 'ping', standby: { idleMinutes: 5 } } },
    ] as unknown as PluginDescriptor[]
    const plan = planStandbyServices({ descriptors: d, mode: 'host', isEnabled: () => true })
    expect(plan.services[0].hostProbe).toEqual({ containerPort: 8080, healthPath: '/ping' })
  })
  it('none 档仍然不过闸', () => {
    expect(planStandbyServices({ descriptors, mode: 'none', isEnabled: () => true }).gated).toBe(false)
  })
})
