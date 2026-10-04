import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 内置包不许再用链接认领的老写法（spec 2026-09-26-link-recognition §6）：`stream.trackUrl`、
 * `stream.downloadPages`、以及 `providers[].serveKeys` 里写域名（带点的键）。宿主只为已经发到 npm 的
 * 旧版包留着兼容层；内置包随宿主同版本出货，没有理由再写它们——写了就说明有人照着旧文档新加了一处，
 * 而兼容层一删它就静默失效。认领一律写 `stream.links`，派发键一律 `<platform>-<名词>`。
 */
const PACKAGES_DIR = fileURLToPath(new URL('../../packages', import.meta.url))

interface Offence { pkg: string; what: string }

function scan(): { scanned: number; offences: Offence[] } {
  const offences: Offence[] = []
  let scanned = 0
  for (const dir of readdirSync(PACKAGES_DIR)) {
    const file = join(PACKAGES_DIR, dir, 'package.json')
    if (!existsSync(file)) continue
    const stream = (JSON.parse(readFileSync(file, 'utf8')) as { stream?: Record<string, unknown> }).stream
    if (!stream) continue
    scanned++
    if (stream.trackUrl != null) offences.push({ pkg: dir, what: 'stream.trackUrl' })
    if (stream.downloadPages != null) offences.push({ pkg: dir, what: 'stream.downloadPages' })
    for (const row of (stream.providers as Array<{ id: string; serveKeys?: string[] }> | undefined) ?? []) {
      for (const key of row.serveKeys ?? []) if (key.includes('.')) offences.push({ pkg: dir, what: `providers[${row.id}].serveKeys "${key}"` })
    }
  }
  return { scanned, offences }
}

describe('内置包不用链接认领的老写法', () => {
  const { scanned, offences } = scan()

  it('确实扫到了包（走空 = 这道闸失效，而不是通过）', () => {
    expect(scanned).toBeGreaterThan(40)
  })

  it('没有 trackUrl / downloadPages / 域名形状的 serveKeys', () => {
    expect(offences, '改写成 stream.links + <platform>-<名词> 的键').toEqual([])
  })
})
