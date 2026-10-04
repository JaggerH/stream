import { describe, it, expect } from 'vitest'
import { deprovisionService } from './deprovision.ts'
import type { DockerClient, DockerContainer, DockerEndpoint } from './standby/docker-api.ts'

/** 假 DockerClient。**这个文件绝不碰真 daemon** —— 活体上跑着用户在用的容器。 */
function fake(o: { ping?: boolean; containers?: DockerContainer[]; throwOn?: string } = {}) {
  const calls: string[] = []
  const boom = (m: string) => { if (o.throwOn === m) throw new Error(`boom:${m}`) }
  const client = {
    async ping() { calls.push('ping'); return o.ping !== false },
    async listByService(s: string) { calls.push(`list:${s}`); boom('list'); return o.containers ?? [] },
    async start() {},
    async stop(id: string) { calls.push(`stop:${id}`); boom('stop') },
    async inspectHostPort() { return null },
    async pullImage() {},
    async createContainer() { return 'x' },
    async removeContainer(id: string) { calls.push(`rm:${id}`); boom('rm') },
    async ensureNetwork() {},
    async inspectState() { return null },
  } as unknown as DockerClient
  const deps = { resolveEndpoint: () => ({} as DockerEndpoint), makeClient: () => client }
  return { deps, calls }
}

const named = (id: string, name: string): DockerContainer => ({ Id: id, State: 'running', Names: [`/${name}`] })

describe('deprovisionService（终审 Minor 5：卸载要把自己建的容器收掉）', () => {
  it('找到 stream-<service> → stop + remove', async () => {
    const f = fake({ containers: [named('c1', 'stream-acme')] })
    expect(await deprovisionService('acme', f.deps)).toBe('removed')
    expect(f.calls).toEqual(['ping', 'list:acme', 'stop:c1', 'rm:c1'])
  })

  it('只收自己建的：compose 建的 <project>-<service>-1 一根汗毛都不碰', async () => {
    const f = fake({ containers: [named('c9', 'stream-acme-1')] })
    expect(await deprovisionService('acme', f.deps)).toBe('absent')
    expect(f.calls.some((c) => c.startsWith('rm:'))).toBe(false)
  })

  it('没有容器 → absent，零写操作', async () => {
    const f = fake({ containers: [] })
    expect(await deprovisionService('acme', f.deps)).toBe('absent')
    expect(f.calls).toEqual(['ping', 'list:acme'])
  })

  it('docker 够不着（解析不出端点）→ unavailable，绝不 throw', async () => {
    expect(await deprovisionService('acme', { resolveEndpoint: () => null })).toBe('unavailable')
  })

  it('ping 不通 → unavailable', async () => {
    const f = fake({ ping: false })
    expect(await deprovisionService('acme', f.deps)).toBe('unavailable')
  })

  it('删除报错 → failed，绝不 throw', async () => {
    const f = fake({ containers: [named('c1', 'stream-acme')], throwOn: 'rm' })
    expect(await deprovisionService('acme', f.deps)).toBe('failed')
  })

  it('stop 报错（容器本来就停着）不挡住删除', async () => {
    const f = fake({ containers: [named('c1', 'stream-acme')], throwOn: 'stop' })
    expect(await deprovisionService('acme', f.deps)).toBe('removed')
    expect(f.calls).toContain('rm:c1')
  })
})
