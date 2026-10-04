import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OPT_IN_CONTENT_PACKAGES, shouldShipPackage } from './release-package-set.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('release package set', () => {
  it('keeps exactly the seven content adapters out of the default release', () => {
    expect([...OPT_IN_CONTENT_PACKAGES].sort()).toEqual([
      '1lou', 'bt0', 'btbtla', 'iqiyi', 'shooter', 'toubiec', 'zuna',
    ])
    expect(OPT_IN_CONTENT_PACKAGES).toHaveLength(7)
  })

  it('only excludes real standalone packages and leaves ordinary packages in the release', () => {
    for (const id of OPT_IN_CONTENT_PACKAGES) {
      const manifest = join(root, 'packages', id, 'package.json')
      expect(existsSync(manifest), `${id} must remain installable`).toBe(true)
      expect(JSON.parse(readFileSync(manifest, 'utf8')).name).toBe(`@streamapp/${id}`)
      expect(shouldShipPackage(id), `${id} must require stream add`).toBe(false)
    }
    expect(shouldShipPackage('xhs')).toBe(true)
  })
})
