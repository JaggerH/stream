import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHttpApp } from './app.ts'
import { StreamService } from '../mcp/tools.ts'
import { Scheduler } from '../scheduler.ts'
import { Registry } from '../registry/registry.ts'
import { DedupStore } from '../dedup-store.ts'
import { ItemStore } from '../item-store.ts'
import { UserStore } from '../store/user-store.ts'
import { fake, health, mk, stream } from './__fixtures__/app-harness.ts'
import type { DownloadOption } from '../video/resolve.ts'

/**
 * `GET /api/download-options` 的 HTTP 半张脸：参数校验 + 错误翻译。脑子（download-resolve 行的
 * decline-chain）是注入的——这里钉的是「后端答了什么」到「HTTP 说了什么」的翻译不走样：
 * 没有成员认领（unsupported url）必须是 400 而不是 502，前端靠这个区分「无可用解析」和
 * 「上游挂了」；两种都不能和网络层失败混成一句「失败」。
 */
function build(resolveDownloads?: (url: string) => Promise<DownloadOption[]>) {
  const dir = mkdtempSync(join(tmpdir(), 'downloads-api-'))
  const registry = new Registry([mk({ id: 'feed-src' })])
  const scheduler = new Scheduler({
    registry, streams: [stream], adapters: new Map([['fake', fake]]),
    resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup: new DedupStore(join(dir, 'd.db')),
  })
  const service = new StreamService({ registry, scheduler, channels: new UserStore(join(dir, 'svc.db')) })
  return createHttpApp({ service, itemStore: new ItemStore(join(dir, 'i.db')), health, resolveDownloads })
}

describe('GET /api/download-options', () => {
  it('解析成功 → {options:[{url,type,…}]}，数组原样透传（不是压成单数）', async () => {
    const app = build(async () => [
      { url: 'magnet:?xt=urn:btih:abc', type: 'magnet' },
      { url: 'https://pan.quark.cn/s/x', type: 'quark', password: '1234' },
    ])
    const res = await app.request('/api/download-options?url=' + encodeURIComponent('https://www.btbtla.com/tdown/1.html'))
    expect(res.status).toBe(200)
    const body = await res.json() as { options: DownloadOption[] }
    expect(body.options).toHaveLength(2)
    expect(body.options[0]).toEqual({ url: 'magnet:?xt=urn:btih:abc', type: 'magnet' })
    expect(body.options[1].password).toBe('1234')
  })

  it('没有成员认领（unsupported url）→ 400 validation_error，不是 502', async () => {
    const app = build(async () => { throw new Error('unsupported url') })
    const res = await app.request('/api/download-options?url=' + encodeURIComponent('https://example.com/x'))
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('validation_error')
  })

  it('成员认领了但上游失败 → 502 upstream_error', async () => {
    const app = build(async () => { throw new Error('no magnet found') })
    const res = await app.request('/api/download-options?url=' + encodeURIComponent('https://www.btbtla.com/tdown/1.html'))
    expect(res.status).toBe(502)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('upstream_error')
  })

  it('缺 url → 400；脑子缺席 → 503', async () => {
    expect((await build(async () => []).request('/api/download-options')).status).toBe(400)
    expect((await build().request('/api/download-options?url=x')).status).toBe(503)
  })

  it('写错查询参数名 → 400 并指出正确写法，不静默忽略（API.md §2）', async () => {
    const res = await build(async () => []).request('/api/download-options?link=x')
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { message: string } }
    expect(body.error.message).toContain('link')
  })
})
