import type { ExportBundle } from './types.ts'

/** 文件名带状态与会话 id，好让用户一眼分出哪份是崩溃那次的。 */
export function bundleFilename(b: ExportBundle): string {
  const stamp = new Date(b.session.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')
  return `stream-diagnostics-${stamp}-${b.session.status}-${b.session.id}.json`
}

/**
 * 本地下载导出物。刻意走 Blob + <a download>：诊断数据**只**交给用户自己，
 * 不自动上传到 Stream 后端或任何第三方（spec 的隐私边界）。
 */
export function downloadBundle(b: ExportBundle, doc: Document): void {
  const blob = new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = doc.createElement('a')
  a.href = url
  a.download = bundleFilename(b)
  a.click()
  URL.revokeObjectURL(url)
}
