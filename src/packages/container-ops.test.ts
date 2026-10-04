import { describe, it, expect } from 'vitest'
import type { PluginDescriptor } from '../plugins/types.ts'
import type { DockerClient, DockerContainer } from '../plugins/standby/docker-api.ts'
import { makeContainerOps, type ContainerOpsDeps } from './container-ops.ts'

const withBackend = (id: string, over: Partial<PluginDescriptor['backend']> = {}): PluginDescriptor =>
  ({ id, name: id, backend: { image: 'img:1', port: 80, health: '/health', ...over } }) as PluginDescriptor
const plain = (id: string): PluginDescriptor => ({ id, name: id }) as PluginDescriptor

const CONTAINER: DockerContainer = { Id: 'cid', State: 'exited', Names: ['/stream-voiceprint'] }

function fakeDocker(over: Partial<DockerClient> = {}): { docker: DockerClient; calls: string[] } {
  const calls: string[] = []
  const docker: DockerClient = {
    ping: async () => { calls.push('ping'); return true },
    listByService: async (s) => { calls.push(`list:${s}`); return [CONTAINER] },
    start: async (id) => { calls.push(`start:${id}`) },
    stop: async (id) => { calls.push(`stop:${id}`) },
    inspectHostPort: async () => null,
    pullImage: async () => { calls.push('pull') },
    createContainer: async () => { calls.push('create'); return 'new' },
    removeContainer: async () => { calls.push('remove') },
    ensureNetwork: async () => { calls.push('network') },
    inspectState: async () => ({ running: false, image: 'img:1' }),
    logs: async (id, tail) => { calls.push(`logs:${id}:${tail}`); return ['line a', 'line b'] },
    exec: async () => ({ exitCode: 0, output: '' }),
    ...over,
  }
  return { docker, calls }
}

function ops(over: Partial<ContainerOpsDeps> = {}, docker?: DockerClient) {
  return makeContainerOps({
    descriptors: () => [withBackend('voiceprint'), plain('xhs')],
    mode: 'host',
    manageEnabled: true,
    resolveEndpoint: () => ({ socketPath: '/s' }),
    makeClient: () => docker ?? fakeDocker().docker,
    provision: async () => ({ service: 'voiceprint', action: 'started' }),
    ...over,
  })
}

describe('containerOps.logs', () => {
  it('没有 backend 槽的包 → no_container(不是错误,是这个包根本没有容器)', async () => {
    const r = await ops().logs('xhs', 100)
    expect(r).toEqual({ ok: false, code: 'no_container' })
  })

  it('不存在的包 id → no_container', async () => {
    expect(await ops().logs('nope', 100)).toEqual({ ok: false, code: 'no_container' })
  })

  it('docker 够不着 → unavailable(和「没有这个容器」必须分开说)', async () => {
    const { docker } = fakeDocker({ ping: async () => false })
    const r = await ops({}, docker).logs('voiceprint', 100)
    expect(r).toEqual({ ok: false, code: 'unavailable' })
  })

  it('端点解析不出来也算 unavailable,且一个 docker 调用都不发', async () => {
    const r = await ops({ resolveEndpoint: () => null }).logs('voiceprint', 100)
    expect(r).toEqual({ ok: false, code: 'unavailable' })
  })

  it('容器从没建起来 → no_container', async () => {
    const { docker } = fakeDocker({ listByService: async () => [] })
    expect(await ops({}, docker).logs('voiceprint', 100)).toEqual({ ok: false, code: 'no_container' })
  })

  it('按 backend.service 找容器,不按包 id', async () => {
    const { docker, calls } = fakeDocker()
    await ops({ descriptors: () => [withBackend('Douyin_TikTok_Download_API', { service: 'douyin' })] }, docker)
      .logs('Douyin_TikTok_Download_API', 100)
    expect(calls).toContain('list:douyin')
  })

  it('拿到行,tail 原样传下去', async () => {
    const { docker, calls } = fakeDocker()
    const r = await ops({}, docker).logs('voiceprint', 50)
    expect(r).toEqual({ ok: true, value: { lines: ['line a', 'line b'], truncated: false } })
    expect(calls).toContain('logs:cid:50')
  })

  it('行数顶到 tail 就报 truncated —— 用户得知道上面还有,不是"就这么多"', async () => {
    const { docker } = fakeDocker({ logs: async () => ['a', 'b'] })
    const r = await ops({}, docker).logs('voiceprint', 2)
    expect(r).toEqual({ ok: true, value: { lines: ['a', 'b'], truncated: true } })
  })

  it('docker 抛错 → unavailable,不把异常泄给路由', async () => {
    const { docker } = fakeDocker({ logs: async () => { throw new Error('socket hangup') } })
    const r = await ops({}, docker).logs('voiceprint', 10)
    expect(r).toMatchObject({ ok: false, code: 'unavailable' })
  })

  // 多个残留容器时挑 running 那个 —— 挑错了就会去读一个几天前退出的容器的日志,
  // 而它看起来完全正常(有内容、有时间戳),只是说的不是这次的事。
  it('多个容器时优先 running', async () => {
    const { docker, calls } = fakeDocker({
      listByService: async () => [
        { Id: 'old', State: 'exited', Names: ['/a'] },
        { Id: 'live', State: 'running', Names: ['/b'] },
      ],
    })
    await ops({}, docker).logs('voiceprint', 10)
    expect(calls).toContain('logs:live:10')
  })
})

describe('containerOps.restart', () => {
  it('没有 backend 槽 → no_container', async () => {
    expect(await ops().restart('xhs')).toEqual({ ok: false, code: 'no_container' })
  })

  it('docker 够不着 → unavailable', async () => {
    const { docker } = fakeDocker({ ping: async () => false })
    expect(await ops({}, docker).restart('voiceprint')).toEqual({ ok: false, code: 'unavailable' })
  })

  // manage_containers 关着**不该挡住重启一个已经存在的容器** —— 那个开关管的是"要不要替你建",
  // 不是"要不要让你重启"。挡住它等于把一个崩溃回环的容器锁死,而用户唯一的自助动作正是重启。
  it('manage_containers 关着,容器已存在 → 照常重启', async () => {
    const { docker } = fakeDocker()
    const r = await ops({ manageEnabled: false }, docker).restart('voiceprint')
    expect(r).toEqual({ ok: true, value: { state: 'running' } })
  })

  it('manage_containers 关着且容器不存在 → not_managed,并说清出路', async () => {
    const { docker } = fakeDocker({ listByService: async () => [] })
    const r = await ops({ manageEnabled: false }, docker).restart('voiceprint')
    expect(r).toMatchObject({ ok: false, code: 'not_managed' })
    expect((r as { message: string }).message).toMatch(/docker compose/)
  })

  it('容器在跑就先 stop 再交给 provision —— 否则 provision 看它 running 会直接判 no-op', async () => {
    const { docker, calls } = fakeDocker({
      listByService: async () => [{ Id: 'live', State: 'running', Names: ['/b'] }],
    })
    await ops({}, docker).restart('voiceprint')
    expect(calls).toContain('stop:live')
  })

  it('容器已退出就不多发一次 stop', async () => {
    const { docker, calls } = fakeDocker()
    await ops({}, docker).restart('voiceprint')
    expect(calls.some((c) => c.startsWith('stop:'))).toBe(false)
  })

  it('provision 报错 → state:error 带上原话(而不是 500)', async () => {
    const { docker } = fakeDocker()
    const r = await ops({ provision: async () => ({ service: 'voiceprint', action: 'created', error: new Error('port in use') }) }, docker)
      .restart('voiceprint')
    expect(r).toEqual({ ok: true, value: { state: 'error', error: 'port in use' } })
  })

  it('provision 自己抛了也不掀翻 —— 契约破了代价不该是 500', async () => {
    const { docker } = fakeDocker()
    const r = await ops({ provision: async () => { throw new Error('boom') } }, docker).restart('voiceprint')
    expect(r).toEqual({ ok: true, value: { state: 'error', error: 'boom' } })
  })

  it('mode=none(后端够不着容器网络)→ unavailable,不白建一个连不上的容器', async () => {
    const { docker } = fakeDocker()
    expect(await ops({ mode: 'none' }, docker).restart('voiceprint')).toMatchObject({ ok: false, code: 'unavailable' })
  })
})
