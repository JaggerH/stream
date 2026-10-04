/** Audio quality normalized onto one comparable scale, so "is this download an upgrade?"
 *  is a single integer comparison. 0 unknown · 1 <192k · 2 192–256k · 3 320k/AAC256 ·
 *  4 lossless CD (flac/alac/wav/ape/aiff) · 5 hi-res (24-bit or >48kHz). */
export interface QualityMeta {
  format?: string
  bitrate?: number
  sampleRate?: number
  bitDepth?: number
}

const LOSSLESS = new Set(['flac', 'alac', 'wav', 'ape', 'aiff'])

export function computeTier(meta: QualityMeta): number {
  const fmt = meta.format?.toLowerCase()
  if (fmt && LOSSLESS.has(fmt)) {
    const hires = (meta.bitDepth ?? 16) > 16 || (meta.sampleRate ?? 44100) > 48000
    return hires ? 5 : 4
  }
  const b = meta.bitrate ?? 0
  if (b <= 0) return 0
  if ((fmt === 'aac' || fmt === 'm4a') && b >= 256) return 3
  if (b >= 320) return 3
  if (b >= 192) return 2
  return 1
}
