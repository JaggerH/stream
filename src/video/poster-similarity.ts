import { refererForUrl } from '../media/serving.ts'

const SIZE = 32

async function luma(bytes: Buffer): Promise<Buffer> {
  const { default: sharp } = await import('sharp')
  return sharp(bytes).resize(SIZE, SIZE, { fit: 'fill' }).grayscale().raw().toBuffer()
}

/**
 * Pearson correlation over 32×32 luma, in [-1, 1]: 1 = identical structure, ~0 = unrelated,
 * negative = inverted contrast.
 *
 * Deliberately NOT a difference hash. A dHash compares neighbouring-pixel gradient *signs*, so
 * every flat region votes on compression noise alone — a coin flip per bit. Localized one-sheets
 * are frequently mostly flat (a photo strip over a plain field), which drags a true match down
 * toward the 0.5 noise floor of a dHash: the zh and en cuts of one real poster scored 0.60/0.63
 * against their own Douban cover, under the 0.54 an unrelated poster reached. Correlation weighs
 * each pixel by its deviation from the mean instead, so a flat field contributes ~nothing rather
 * than noise, and the shared artwork decides. The same pairs score 0.72–0.99, against ≤0.36 for
 * unrelated works.
 */
export async function comparePosterBuffers(source: Buffer, candidate: Buffer): Promise<number> {
  const [left, right] = await Promise.all([luma(source), luma(candidate)])
  const count = Math.min(left.length, right.length)
  let leftMean = 0
  let rightMean = 0
  for (let index = 0; index < count; index++) { leftMean += left[index]; rightMean += right[index] }
  leftMean /= count
  rightMean /= count
  let covariance = 0
  let leftVariance = 0
  let rightVariance = 0
  for (let index = 0; index < count; index++) {
    const leftDelta = left[index] - leftMean
    const rightDelta = right[index] - rightMean
    covariance += leftDelta * rightDelta
    leftVariance += leftDelta * leftDelta
    rightVariance += rightDelta * rightDelta
  }
  // A uniform image has no deviation to correlate against, so nothing can be concluded from it.
  return leftVariance && rightVariance ? covariance / Math.sqrt(leftVariance * rightVariance) : 0
}

async function posterBytes(url: string): Promise<Buffer | null> {
  try {
    // 带哪个 Referer 问包的 serving 声明（与图片代理同一个函数），宿主不认识任何图床。
    const referer = refererForUrl(url)
    const response = await fetch(url, {
      headers: { accept: 'image/*,*/*', ...(referer ? { referer } : {}) },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return null
    const bytes = Buffer.from(await response.arrayBuffer())
    return bytes.length > 5_000_000 ? null : bytes
  } catch { return null }
}

export async function comparePosterUrls(sourceUrl: string, candidateUrl: string): Promise<number | null> {
  try {
    const [source, candidate] = await Promise.all([posterBytes(sourceUrl), posterBytes(candidateUrl)])
    return source && candidate ? await comparePosterBuffers(source, candidate) : null
  } catch { return null }
}
