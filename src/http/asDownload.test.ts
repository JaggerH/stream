import { describe, expect, it } from 'vitest'
import { asDownload } from './app.ts'

describe('asDownload', () => {
  it('adds a Content-Disposition attachment header, preserving status/body/headers', async () => {
    const src = new Response('hello', {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': '5' },
    })
    const out = asDownload(src, '测试视频')
    expect(out.status).toBe(200)
    expect(out.headers.get('content-type')).toBe('video/mp4')
    expect(out.headers.get('content-length')).toBe('5')
    const cd = out.headers.get('content-disposition')
    expect(cd).toContain('attachment')
    expect(cd).toContain(".mp4")
    expect(await out.text()).toBe('hello')
  })
})
