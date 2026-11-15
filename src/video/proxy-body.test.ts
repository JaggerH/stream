// src/video/proxy-body.test.ts
import { describe, expect, it } from 'vitest'
import { guardUpstreamBody } from './proxy-body.ts'

function byteStream(chunks: Uint8Array[], failWith?: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // chunk 逐个异步给、错误也异步发：同步 error 会把已排队的 chunk 整个丢掉，
      // 读端一次都拿不到——那不是这条闸要应对的真实形状（真实断流发生在转发途中）。
      let i = 0
      const step = (): void => {
        if (i < chunks.length) {
          controller.enqueue(chunks[i++])
          setTimeout(step, 0)
        } else if (failWith) setTimeout(() => controller.error(failWith), 0)
        else controller.close()
      }
      step()
    },
  })
}

describe('guardUpstreamBody', () => {
  it('上游断流：读端以 ERR_STREAM_PREMATURE_CLOSE 收场，记一行带 host 的日志，query 不进日志', async () => {
    const lines: string[] = []
    const body = byteStream(
      [new TextEncoder().encode('hello'), new TextEncoder().encode(' world')],
      new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }),
    )
    const resp = guardUpstreamBody(
      new Response(body, { status: 200, headers: { 'content-type': 'video/mp4' } }),
      'http://cdn.example.com/seg.bin?token=SECRET&sig=x',
      { log: (m) => lines.push(m) },
    )
    expect(resp.status).toBe(200)
    const reader = resp.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value!)).toBe('hello')
    const second = await reader.read()
    expect(new TextDecoder().decode(second.value!)).toBe(' world')
    await expect(reader.read()).rejects.toMatchObject({ code: 'ERR_STREAM_PREMATURE_CLOSE' })
    await expect(reader.read()).rejects.toMatchObject({ code: 'ERR_STREAM_PREMATURE_CLOSE' })

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('cdn.example.com')
    expect(lines[0]).toContain('terminated')
    expect(lines[0]).toContain('11 字节')
    expect(lines[0]).not.toContain('SECRET')
    expect(lines[0]).not.toContain('sig=')
  })

  it('完整流：一字节不丢、状态头原样、不记日志', async () => {
    const lines: string[] = []
    const payload = new TextEncoder().encode('all good')
    const resp = guardUpstreamBody(
      new Response(byteStream([payload]), { status: 206, statusText: 'Partial Content', headers: { 'content-range': 'bytes 0-7/8' } }),
      'http://cdn.example.com/f.bin',
      { log: (m) => lines.push(m) },
    )
    expect(resp.status).toBe(206)
    expect(resp.statusText).toBe('Partial Content')
    expect(resp.headers.get('content-range')).toBe('bytes 0-7/8')
    const buf = new Uint8Array(await resp.arrayBuffer())
    expect(Array.from(buf)).toEqual(Array.from(payload))
    expect(lines).toHaveLength(0)
  })

  it('下游取消（播放器换档/seek）：安静收场，不记断流日志', async () => {
    const lines: string[] = []
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk'))
      },
      cancel() {
        cancelled = true
      },
    })
    const resp = guardUpstreamBody(new Response(body), 'http://cdn.example.com/seg.bin', { log: (m) => lines.push(m) })
    const reader = resp.body!.getReader()
    await reader.read()
    await reader.cancel()
    expect(cancelled).toBe(true)
    await new Promise((r) => setTimeout(r, 10))
    expect(lines).toHaveLength(0)
  })

  it('没有 body 的响应原样返回', () => {
    const resp = guardUpstreamBody(new Response(null, { status: 304 }), 'http://cdn.example.com/x')
    expect(resp.body).toBeNull()
  })
})
