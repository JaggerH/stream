import type { Media } from '../content/types.ts'

export interface SourceBytes {
  bytes: Uint8Array
  mime: string
}

export interface ParseableSource {
  kind: 'image' | 'pdf'
  url: string
}

export interface SourceDeps {
  /** fetch a url to bytes, wired by the caller to safe-fetch (SSRF allowlist + cookies).
   *  Returns null on a disallowed/failed fetch. */
  fetchUrl: (url: string) => Promise<Response | null>
}

const PDF_RE = /\.pdf(\?|#|$)/i

/** item 上**所有**图片的 URL（保持 media 顺序，第一张在前）。gallery/图文多图的 ocr 分支
 *  靠它收齐全部图——单图路径（`parseableSource`）只取第一张，那是「一条内容」的语义；
 *  多图是「一个集合」，要走逐图并发管线（见 conversions/converters/parse.ts）。 */
export function imageUrls(media: Media[] | undefined): string[] {
  return (media ?? [])
    .filter((m): m is Extract<Media, { kind: 'image' }> => m.kind === 'image')
    .map((m) => m.url)
}

/** The first parseable source on an item: an image takes precedence (the card's picture),
 *  otherwise a PDF link/enclosure. Returns undefined when neither is present. */
export function parseableSource(media: Media[] | undefined): ParseableSource | undefined {
  const list = media ?? []
  const image = list.find((m): m is Extract<Media, { kind: 'image' }> => m.kind === 'image')
  if (image) return { kind: 'image', url: image.url }
  const pdf = list.find((m): m is Extract<Media, { kind: 'link' }> => m.kind === 'link' && PDF_RE.test(m.url))
  if (pdf) return { kind: 'pdf', url: pdf.url }
  return undefined
}

/**
 * Resolve a parseable item's source to raw bytes for MinerU: an item's image, or a PDF
 * link fetched through the injected safe-fetch. Returns null when nothing parseable is
 * present or the fetch fails. The mime comes from the response (falling back to a sensible
 * default by source kind) so the client can route pdf vs image.
 */
export async function resolveSourceBytes(media: Media[] | undefined, deps: SourceDeps): Promise<SourceBytes | null> {
  const src = parseableSource(media)
  if (!src) return null
  const resp = await deps.fetchUrl(src.url)
  if (!resp || !resp.ok) return null
  const ct = resp.headers.get('content-type')?.split(';')[0]?.trim()
  const mime = ct || (src.kind === 'pdf' ? 'application/pdf' : 'image/jpeg')
  return { bytes: new Uint8Array(await resp.arrayBuffer()), mime }
}
