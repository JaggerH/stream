import { describe, expect, it, vi } from 'vitest'
import { bundleFilename, downloadBundle } from './exportBundle.ts'
import type { ExportBundle } from './types.ts'

const bundle: ExportBundle = {
  session: {
    id: 'abc123',
    startedAt: 1752537600000,
    lastWriteAt: 1752537600000,
    appVersion: 'test',
    ua: 'Chrome/131',
    status: 'suspected-abnormal',
  },
  samples: [],
  events: [],
  exportedAt: 1752537600000,
  notes: ['note'],
}

describe('bundleFilename', () => {
  it('文件名带会话状态与 id，便于区分崩溃记录', () => {
    const name = bundleFilename(bundle)
    expect(name).toContain('abc123')
    expect(name).toContain('suspected-abnormal')
    expect(name.endsWith('.json')).toBe(true)
  })
})

describe('downloadBundle', () => {
  it('走本地 Blob 下载 —— 绝不 fetch/上传到任何服务端', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const createUrl = vi.fn(() => 'blob:fake')
    const revokeUrl = vi.fn()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: revokeUrl }))

    const clicked = vi.fn()
    const anchor = document.createElement('a')
    anchor.click = clicked
    vi.spyOn(document, 'createElement').mockReturnValueOnce(anchor)

    downloadBundle(bundle, document)

    expect(clicked).toHaveBeenCalledOnce()
    expect(createUrl).toHaveBeenCalledOnce()
    expect(revokeUrl).toHaveBeenCalledOnce()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(anchor.download).toBe(bundleFilename(bundle))

    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
})
