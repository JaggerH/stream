import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('bundle 声明', () => {
  it('package.json#dsh.bundle.patch 指向一个存在的文件，且它进 files', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dsh?: { bundle?: { patch?: string } }; files: string[] }
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(existsSync(join(ROOT, 'cordis.patch.yml'))).toBe(true)
    expect(pkg.files).toContain('cordis.patch.yml')
  })
})
