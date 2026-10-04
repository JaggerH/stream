import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchArtifact, fetchRunManifest, fetchLiveItems } from './artifact.ts'

const conn = { baseUrl: 'http://x', token: '' } as never
afterEach(() => { vi.unstubAllGlobals() })

function stub(status: number, body: unknown) {
  const fn = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fn)
  return fn
}

describe('research 取数', () => {
  it('artifact 路径按 stream/run/name 拼', async () => {
    const f = stub(200, { schema: 'artifact/v1', view: 'text', name: 'n', data: 'x', config: {} })
    await fetchArtifact(conn, 's1', 'r1', 'n')
    expect(String(f.mock.calls[0]![0])).toContain('/api/research/streams/s1/runs/r1/artifacts/n')
  })

  it('artifact 名里的特殊字符被编码', async () => {
    const f = stub(200, { schema: 'artifact/v1', view: 'text', name: 'a b', data: '', config: {} })
    await fetchArtifact(conn, 's1', 'r1', 'a b')
    expect(String(f.mock.calls[0]![0])).toContain('artifacts/a%20b')
  })

  it('非 2xx 抛错,错误原文带出来', async () => {
    stub(404, { error: 'cannot read artifact /d/r1/n.json' })
    await expect(fetchArtifact(conn, 's1', 'r1', 'n')).rejects.toThrow(/cannot read artifact/)
  })

  it('manifest 的 artifacts 清单原样返回', async () => {
    stub(200, { schema: 'run/v1', id: 'r1', artifacts: [{ name: 'a', view: 'table' }] })
    const m = await fetchRunManifest(conn, 's1', 'r1')
    expect(m.artifacts).toEqual([{ name: 'a', view: 'table' }])
  })

  it('live 列表剥掉 { items } 外壳', async () => {
    stub(200, { items: [{ id: 'i1' }] })
    expect(await fetchLiveItems(conn, 's1')).toEqual([{ id: 'i1' }])
  })
})
