// 扩展 id 与 `manifest.key` 的绑定——**这是整条链路唯一的静默失败点**。
//
// Chrome 从 `manifest.key`（公钥）派生扩展 id；native messaging 的 `allowed_origins` 只放行
// 一个 id（`src/ext-id.ts` 的 `STREAM_EXTENSION_ID`，`capabilities/{browser,desktop}` 各存一份
// 同值常量）。两者一旦对不上，表现是"扩展装上了、握手正常、native messaging 就是不认它"，
// 而**没有任何一处会报错**——Chrome 只是不把它当成那个被放行的 id。
//
// 所以这条测试不测代码，测的是**产物**：从真的 `manifest.json` 现算一遍 id，必须等于常量。
// 产物没构建时 `skip` 并打印原因——不假绿（一条恒绿的测试比没有测试更坏）。
//
// 派生算法：SHA-256(公钥 DER 字节) 取前 16 字节，每字节拆成两个 nibble，各映射到
// `'a' + nibble`（即 0→a … 15→p），拼成 32 位。
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STREAM_EXTENSION_ID } from '../ext-id.ts'

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const manifestPath = join(repoRoot, 'extension/.output/chrome-mv3/manifest.json')

/** `manifest.key`（base64 的公钥 DER）→ Chrome 扩展 id。 */
export function deriveExtensionId(keyBase64: string): string {
  const digest = createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest()
  let id = ''
  for (const byte of digest.subarray(0, 16)) {
    id += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 0x0f))
  }
  return id
}

describe('扩展 id 是从产物的 manifest.key 派生的', () => {
  it('派生算法本身：全 0 的公钥有一个可手算的答案（产物缺席也要跑）', () => {
    // SHA-256("") 的前两个字节是 0xe3 0xb0 → (14,3)=o,d / (11,0)=l,a
    expect(deriveExtensionId('')).toHaveLength(32)
    expect(deriveExtensionId('')).toBe('odlameecjipmbmbejkplpemijjgpljce')
  })

  const built = existsSync(manifestPath)
  const run = built ? it : it.skip
  if (!built) {
    console.warn(`[extension-id.derive] 跳过：${manifestPath} 不在——先跑 \`pnpm --dir extension build\`。`)
  }

  run('产物里那把 key 派生出的 id === STREAM_EXTENSION_ID（对不上就是静默不配对）', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { key?: string }
    expect(manifest.key, 'manifest.key 不在——wxt.config.ts 里那把固定 key 没进产物').toBeTruthy()
    expect(deriveExtensionId(manifest.key!)).toBe(STREAM_EXTENSION_ID)
  })
})
