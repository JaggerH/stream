import { gunzipSync } from 'node:zlib'

export interface TarEntry { path: string; data: Buffer }

const readStr = (b: Buffer, off: number, len: number) => {
  const end = b.indexOf(0, off)
  return b.subarray(off, end === -1 || end > off + len ? off + len : end).toString('utf-8')
}

/** 最小 ustar 解包：只取常规文件，剥 npm 的 "package/" 前缀，拒绝越界路径。
 *  手写而非引 tar 依赖：recipe 包很小、结构固定，一个 512 块解析器 40 行,不值当为它进一个带
 *  符号链接/设备文件语义的完整实现(那些形态在这里本来就该拒)。 */
export function untarGz(tgz: Buffer): TarEntry[] {
  const buf = gunzipSync(tgz)
  const entries: TarEntry[] = []
  let off = 0
  while (off + 512 <= buf.length) {
    const block = buf.subarray(off, off + 512)
    if (block.every((x) => x === 0)) break
    const name = readStr(block, 0, 100)
    const prefix = readStr(block, 345, 155)
    const size = parseInt(readStr(block, 124, 12).trim() || '0', 8)
    const typeflag = block[156]
    off += 512
    const next = off + Math.ceil(size / 512) * 512
    if (typeflag === 0x30 || typeflag === 0) {          // '0' or NUL = regular file
      const full = prefix ? `${prefix}/${name}` : name
      const path = full.replace(/^package\//, '')
      if (path.split('/').some((seg) => seg === '..') || path.startsWith('/')) {
        throw new Error(`tar entry escapes package root: ${full}`)
      }
      entries.push({ path, data: Buffer.from(buf.subarray(off, off + size)) })
    }
    off = next
  }
  return entries
}
