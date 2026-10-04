import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { untarGz } from './untar.ts'

const tgz = readFileSync(join(import.meta.dirname, '__fixtures__', 'sample.tgz'))

/** 手工拼一个最小 ustar 头块（512 字节），只填实现会读的字段：
 * name(0,100) / size(124,12,octal ASCII) / checksum(148,8, 实现不校验,填空格) / typeflag(156,1)。
 * 不写 magic/prefix 等实现不读的字段——untarGz 本来就不校验它们。 */
function makeUstarHeader(name: string): Buffer {
  const block = Buffer.alloc(512)
  block.write(name, 0, 'utf-8')
  block.write('0000000000\0', 124, 'ascii') // size = 0 (octal), NUL-terminated
  block.fill(0x20, 148, 156) // checksum: 8 spaces — untarGz never reads it
  block[156] = 0x30 // typeflag '0' = regular file
  return block
}

function makeTgzWithEntry(name: string): Buffer {
  return gzipSync(makeUstarHeader(name))
}

describe('untarGz', () => {
  it('extracts regular files with package/ prefix stripped', () => {
    const entries = untarGz(tgz)
    const paths = entries.map((e) => e.path).sort()
    expect(paths).toEqual(['package.json', 'sub/inner.txt', 'x-a.recipe.json'])
    expect(JSON.parse(entries.find((e) => e.path === 'package.json')!.data.toString()).name).toBe('@t/x')
    expect(entries.find((e) => e.path === 'sub/inner.txt')!.data.toString()).toBe('nested')
  })

  it('rejects non-gzip input', () => {
    expect(() => untarGz(Buffer.from('not a tgz'))).toThrow()
  })

  it('rejects path traversal via .. segment', () => {
    const evil = makeTgzWithEntry('package/../evil.txt')
    expect(() => untarGz(evil)).toThrow(/escapes package root/)
  })

  it('rejects path traversal via absolute path', () => {
    const evil = makeTgzWithEntry('/etc/passwd')
    expect(() => untarGz(evil)).toThrow(/escapes package root/)
  })
})
