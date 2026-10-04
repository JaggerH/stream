/**
 * 流式 multipart/form-data 解析——`POST /api/netdisk/fs/put` 用它把上传的文件**边收边落盘**，
 * 而不是 `c.req.formData()` 那样把整份文件读进内存（undici 的 File 是内存 Blob）。
 *
 * 为什么自己写而不是引 busboy：仓库里没有直接依赖，`@fastify/busboy` 只作为 undici 的传递依赖
 * 躺在 `.pnpm` 里（strict 模式下 import 不到）；而这里只需要最朴素的一档——顺序产出各 part、
 * 分隔符可以跨 chunk、不支持嵌套 multipart。加一个依赖换 100 行，不值。
 *
 * 产出形状：async generator，每个 part 是 `{ name, filename?, headers, data }`，`data` 是该段字节
 * 的 AsyncIterable。**必须把当前 part 的 data 消费完再取下一个**（它们共用同一条底层流）。
 */

export interface MultipartPart {
  name: string
  filename?: string
  headers: Record<string, string>
  data: AsyncIterable<Uint8Array>
}

/** 从 content-type 里取 boundary；不是 multipart/form-data → null。 */
export function multipartBoundary(contentType: string | undefined | null): string | null {
  if (!contentType || !/^multipart\/form-data/i.test(contentType)) return null
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  const b = (m?.[1] ?? m?.[2])?.trim()
  return b || null
}

const CRLF2 = Buffer.from('\r\n\r\n')

function parseHeaders(block: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of block.split('\r\n')) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  return out
}

/** content-disposition 里的 name / filename（filename 支持 `\"` 转义与 %22）。 */
function dispositionParam(disp: string, key: string): string | undefined {
  const m = new RegExp(`(?:^|;)\\s*${key}=(?:"((?:\\\\.|[^"\\\\])*)"|([^;]+))`, 'i').exec(disp)
  if (!m) return undefined
  const raw = m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? '').trim()
  return raw.replace(/%22/g, '"')
}

/**
 * 解析。分隔符统一按 `\r\n--<boundary>` 找（首个 part 前的 `--<boundary>` 通过在开头补一个 `\r\n` 归一）。
 * 每段数据往外吐时永远扣住尾部 `delim.length - 1` 字节不吐——分隔符可能正好被切在那里。
 */
export async function* parseMultipart(body: ReadableStream<Uint8Array>, boundary: string): AsyncGenerator<MultipartPart> {
  const delim = Buffer.from(`\r\n--${boundary}`)
  const reader = body.getReader()
  let buf = Buffer.from('\r\n')
  let done = false

  const fill = async (): Promise<boolean> => {
    if (done) return false
    const r = await reader.read()
    if (r.done) { done = true; return false }
    buf = Buffer.concat([buf, Buffer.from(r.value)])
    return true
  }

  // 定位到第一个分隔符之后
  for (;;) {
    const i = buf.indexOf(delim)
    if (i >= 0) { buf = buf.subarray(i + delim.length); break }
    if (!(await fill())) throw new Error('multipart: truncated before first boundary')
  }

  for (;;) {
    // 分隔符后面：`--` = 结束；`\r\n` = 下一段的头
    while (buf.length < 2) if (!(await fill())) throw new Error('multipart: truncated after boundary')
    if (buf[0] === 0x2d && buf[1] === 0x2d) return
    if (!(buf[0] === 0x0d && buf[1] === 0x0a)) throw new Error('multipart: malformed boundary line')
    buf = buf.subarray(2)

    // 头块
    let headerEnd: number
    for (;;) {
      headerEnd = buf.indexOf(CRLF2)
      if (headerEnd >= 0) break
      if (!(await fill())) throw new Error('multipart: truncated inside part headers')
    }
    const headers = parseHeaders(buf.subarray(0, headerEnd).toString('utf8'))
    buf = buf.subarray(headerEnd + CRLF2.length)
    const disp = headers['content-disposition']
    if (!disp) throw new Error('multipart: part without content-disposition')
    const name = dispositionParam(disp, 'name') ?? ''
    const filename = dispositionParam(disp, 'filename')

    // 数据段：吐到分隔符为止；未见分隔符时扣住尾部 delim.length-1 字节
    let partDone = false
    const data: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const i = buf.indexOf(delim)
          if (i >= 0) {
            if (i > 0) yield new Uint8Array(buf.subarray(0, i))
            buf = buf.subarray(i + delim.length)
            partDone = true
            return
          }
          const keep = delim.length - 1
          if (buf.length > keep) {
            yield new Uint8Array(buf.subarray(0, buf.length - keep))
            buf = buf.subarray(buf.length - keep)
          }
          if (!(await fill())) throw new Error('multipart: truncated inside part body')
        }
      },
    }
    yield { name, filename, headers, data }
    // 调用方没读完就要下一段：替它读干净，别让下一段从半截数据开始
    if (!partDone) for await (const _ of data) { /* drain */ }
  }
}
