import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STREAM_EXTENSION_ID } from './extension-id.ts'

// 真相源在 Stream 仓库 src/ext-id.ts；本包只能带一份副本（发到 npm 后没有那个文件）。
// 两份分家的症状是 native messaging 永远登记不上、而握手正常——所以在仓库里钉住相等。
describe('extensionId 副本', () => {
  it('与 Stream 仓库 src/ext-id.ts 逐字相等', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'ext-id.ts'), 'utf8')
    const m = src.match(/STREAM_EXTENSION_ID = '([a-p]{32})'/)
    expect(m?.[1]).toBe(STREAM_EXTENSION_ID)
  })
})
