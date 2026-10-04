import { describe, it, expect, vi } from 'vitest'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadBundleFromFile, loadBundleFromUrl } from './transport.ts'
import { serializeBundle, STREAM_BUNDLE_FORMAT, type StreamBundleV1 } from './bundle-format.ts'

const b: StreamBundleV1 = {
  format: STREAM_BUNDLE_FORMAT, meta: { title: 'T', created: '2026-07-18', revision: '1.0.0' },
  channels: [{ id: 'c', label: 'C', present: 'timeline', stream_ids: [], options: {} }],
  streams: [], providers: [], requires: { plugins: [], recipes: [], credentials: [], runtimeConfig: [] }, embedded: { recipes: {} },
}

describe('transport', () => {
  it('URL 与文件结果一致（host 无关）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bun-'))
    const fp = join(dir, 'b.json')
    writeFileSync(fp, serializeBundle(b))
    const fromFile = await loadBundleFromFile(fp)

    const fakeFetch = vi.fn(async () => new Response(serializeBundle(b), { status: 200 }))
    const fromUrlA = await loadBundleFromUrl('https://raw.githubusercontent.com/x/y/b.json', fakeFetch)
    const fromUrlB = await loadBundleFromUrl('https://my-own-host.example/whatever', fakeFetch)

    expect(fromFile.ok && fromUrlA.ok && fromUrlB.ok).toBe(true)
    if (fromFile.ok && fromUrlA.ok && fromUrlB.ok) {
      expect(fromUrlA.bundle).toEqual(fromFile.bundle)
      expect(fromUrlB.bundle).toEqual(fromFile.bundle) // 不同 host 结果一致
    }
  })

  it('URL 非 200 → ok:false 可读错误', async () => {
    const r = await loadBundleFromUrl('https://x/y', vi.fn(async () => new Response('nope', { status: 404 })))
    expect(r.ok).toBe(false)
  })
})
