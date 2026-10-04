import { describe, it, expect } from 'vitest'
import { multipartBoundary, parseMultipart } from './multipart-stream.ts'

/** 把一段字节按 `sizes` 切成若干 chunk 喂进去——分隔符跨 chunk 是这类解析器唯一会错的地方。 */
function streamOf(buf: Buffer, sizes: number[]): ReadableStream<Uint8Array> {
  let off = 0
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (off >= buf.length) { ctrl.close(); return }
      const n = sizes[i++ % sizes.length] ?? buf.length
      ctrl.enqueue(new Uint8Array(buf.subarray(off, off + n)))
      off += n
    },
  })
}

function body(parts: Array<{ name: string; filename?: string; data: Buffer | string }>, boundary = 'XbndX'): Buffer {
  const chunks: Buffer[] = []
  for (const p of parts) {
    const disp = `form-data; name="${p.name}"` + (p.filename ? `; filename="${p.filename}"` : '')
    chunks.push(Buffer.from(`--${boundary}\r\ncontent-disposition: ${disp}\r\n` + (p.filename ? 'content-type: application/octet-stream\r\n' : '') + '\r\n'))
    chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data))
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(chunks)
}

async function collect(stream: ReadableStream<Uint8Array>, boundary: string) {
  const out: Array<{ name: string; filename?: string; data: Buffer }> = []
  for await (const part of parseMultipart(stream, boundary)) {
    const bufs: Buffer[] = []
    for await (const c of part.data) bufs.push(Buffer.from(c))
    out.push({ name: part.name, filename: part.filename, data: Buffer.concat(bufs) })
  }
  return out
}

describe('multipartBoundary', () => {
  it('从 content-type 里取 boundary（带引号 / 不带都认）', () => {
    expect(multipartBoundary('multipart/form-data; boundary=abc')).toBe('abc')
    expect(multipartBoundary('multipart/form-data; boundary="a b"')).toBe('a b')
    expect(multipartBoundary('application/json')).toBeNull()
    expect(multipartBoundary(undefined)).toBeNull()
  })
})

describe('parseMultipart：顺序产出各 part，文件段按 chunk 流出', () => {
  const file = Buffer.alloc(10_000, 'x').fill('\r\n--Xbnd', 4000, 4007) // 内容里故意埋一段像分隔符的前缀

  it('字段 + 文件，整份一次喂进来', async () => {
    const parts = await collect(streamOf(body([{ name: 'path', data: '/quark/a b/c.txt' }, { name: 'file', filename: 'c.txt', data: file }]), [1 << 20]), 'XbndX')
    expect(parts.map((p) => [p.name, p.filename])).toEqual([['path', undefined], ['file', 'c.txt']])
    expect(parts[0]!.data.toString()).toBe('/quark/a b/c.txt')
    expect(parts[1]!.data.equals(file)).toBe(true)
  })

  it('分隔符被切在任意 chunk 边界上也不会丢字节、不会多字节', async () => {
    const raw = body([{ name: 'path', data: '/p' }, { name: 'file', filename: 'f', data: file }])
    for (const sizes of [[1], [3], [7], [64], [1000, 1, 2, 5000]]) {
      const parts = await collect(streamOf(raw, sizes), 'XbndX')
      expect(parts[0]!.data.toString(), `sizes=${sizes}`).toBe('/p')
      expect(parts[1]!.data.equals(file), `sizes=${sizes}`).toBe(true)
    }
  })

  it('空文件也是一个 part', async () => {
    const parts = await collect(streamOf(body([{ name: 'file', filename: 'e', data: '' }]), [5]), 'XbndX')
    expect(parts).toHaveLength(1)
    expect(parts[0]!.data.length).toBe(0)
  })

  it('filename 里的 %22 / 转义引号照样读出名字；没 content-disposition 的段直接报错', async () => {
    const parts = await collect(streamOf(body([{ name: 'file', filename: 'a\\"b', data: 'z' }]), [9]), 'XbndX')
    expect(parts[0]!.filename).toBe('a"b')
    const broken = Buffer.from('--XbndX\r\ncontent-type: text/plain\r\n\r\nz\r\n--XbndX--\r\n')
    await expect(collect(streamOf(broken, [100]), 'XbndX')).rejects.toThrow(/content-disposition/)
  })

  it('没收到结尾分隔符就断流 → 报错，不把半截文件当完整', async () => {
    const raw = body([{ name: 'file', filename: 'f', data: 'hello' }])
    const cut = raw.subarray(0, raw.length - 12)
    await expect(collect(streamOf(cut, [4]), 'XbndX')).rejects.toThrow(/truncated/i)
  })
})
