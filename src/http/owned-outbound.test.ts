import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ownedFetch, owned } from './owned-outbound.ts'

let server: Server | undefined
afterEach(() => server?.close())

/** 起一个本地 http server，回声请求方法 + 收到的 headers，返回 base URL。 */
async function echoServer(): Promise<string> {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ method: req.method, headers: req.headers, body }))
    })
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  const { port } = server!.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

describe('ownedFetch', () => {
  it('GET 返回标准 Response 并透传自定义 header', async () => {
    const base = await echoServer()
    const res = await ownedFetch(`${base}/`, { headers: { 'X-Probe': 'stream' } })
    expect(res.ok).toBe(true)
    const json = (await res.json()) as { method: string; headers: Record<string, string> }
    expect(json.method).toBe('GET')
    expect(json.headers['x-probe']).toBe('stream')
  })

  it('POST 透传 body', async () => {
    const base = await echoServer()
    const res = await ownedFetch(`${base}/`, { method: 'POST', body: 'hello' })
    const json = (await res.json()) as { method: string; body: string }
    expect(json.method).toBe('POST')
    expect(json.body).toBe('hello')
  })

  it('非 2xx 由调用方读取 res.ok（不抛）', async () => {
    server = createServer((_req, res) => {
      res.statusCode = 503
      res.end('nope')
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const { port } = server!.address() as AddressInfo
    const res = await ownedFetch(`http://127.0.0.1:${port}/`)
    expect(res.ok).toBe(false)
    expect(res.status).toBe(503)
  })

  it('网络错误抛出（连不上的端口）', async () => {
    await expect(ownedFetch('http://127.0.0.1:1/')).rejects.toBeTruthy()
  })

  it('owned.httpGet 是可用的原始 node http get', async () => {
    const base = await echoServer()
    const seen = await new Promise<Record<string, string>>((resolve, reject) => {
      owned
        .httpGet(new URL(base), { headers: { 'X-Node': 'raw' } }, (res) => {
          let b = ''
          res.on('data', (c) => (b += c))
          res.on('end', () => resolve((JSON.parse(b) as { headers: Record<string, string> }).headers))
        })
        .on('error', reject)
    })
    expect(seen['x-node']).toBe('raw')
  })
})
