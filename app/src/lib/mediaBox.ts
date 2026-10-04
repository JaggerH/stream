/** Sizing rule for a card's media preview (single image or video), kept as a pure
 *  function so the layout is deterministic and unit-tested — the component just wires
 *  measurement → this → style.
 *
 *  Known dimensions branch by media kind:
 *   - video: wide uses a stable 16:9 frame; tall/square uses a stable 9:16 frame
 *   - image: wide fills the available width at its natural ratio; tall/square uses a
 *     510px height cap and scales proportionally
 *
 *  Dimensions unknown (a video poster that hasn't loaded) → a full-width 16:9 placeholder
 *  so the box never collapses; it re-sizes once the dimensions are known. */

export const MAX_MEDIA_HEIGHT = 507 // px — default height cap for tall/square single video
export const MAX_IMAGE_HEIGHT = 510 // px — height cap for tall/square single image
export const FIXED_RATIO = 16 / 9 // placeholder ratio while dimensions are unknown
export const PORTRAIT_RATIO = 9 / 16 // stable frame ratio for tall/square media
export const MAX_RATIO = 3 // legacy export; known media no longer crops ultra-wide ratios
export type MediaKind = 'image' | 'video'

export interface MediaBoxInput {
  /** intrinsic media width in px (0/NaN if not yet known) */
  naturalW: number
  /** intrinsic media height in px (0/NaN if not yet known) */
  naturalH: number
  /** available column width in px */
  containerW: number
  /** height cap in px (defaults to MAX_MEDIA_HEIGHT) */
  maxHeight?: number
  /** image vs video sizing mode */
  kind?: MediaKind
}

export interface MediaBoxSize {
  width: number
  height: number
  /** true → the placeholder is cropped into a fixed ratio box */
  fixedRatio: boolean
}

const valid = (n: number) => Number.isFinite(n) && n > 0

export interface Dims {
  w: number
  h: number
}

/** Pick which dimensions to size a media box from. A known video size wins over a poster
 *  measurement — a cover poster's aspect can differ from the actual stream (e.g. a
 *  portrait Douyin cover over a widescreen clip), and the video is the source of truth
 *  once playing. The poster is the fallback until the video size is known. */
export function resolveMediaDims(
  video: Dims | null | undefined,
  poster: Dims | null | undefined
): Dims | null {
  if (video && valid(video.w) && valid(video.h)) return video
  if (poster && valid(poster.w) && valid(poster.h)) return poster
  return null
}

/** A full-width 16:9 box, capped — used only while dimensions are unknown. */
function fixedBox(containerW: number, cap: number, cropped: boolean): MediaBoxSize {
  return { width: Math.round(containerW), height: Math.round(Math.min(containerW / FIXED_RATIO, cap)), fixedRatio: cropped }
}

export function computeMediaBox(input: MediaBoxInput): MediaBoxSize {
  const { naturalW, naturalH, containerW } = input
  const kind = input.kind ?? 'image'
  const defaultCap = kind === 'video' ? MAX_MEDIA_HEIGHT : MAX_IMAGE_HEIGHT
  const cap = valid(input.maxHeight as number) ? (input.maxHeight as number) : defaultCap

  if (!valid(containerW)) return { width: 0, height: 0, fixedRatio: false }

  // dimensions unknown → placeholder (not a crop decision yet)
  if (!valid(naturalW) || !valid(naturalH)) return fixedBox(containerW, cap, false)

  if (kind === 'video') {
    if (naturalW > naturalH) {
      return { width: Math.round(containerW), height: Math.round(containerW / FIXED_RATIO), fixedRatio: true }
    }

    const tallCap = Math.min(cap, MAX_MEDIA_HEIGHT)
    const height = Math.min(tallCap, containerW / PORTRAIT_RATIO)
    return { width: Math.round(height * PORTRAIT_RATIO), height: Math.round(height), fixedRatio: true }
  }

  if (naturalW > naturalH) {
    const height = containerW * (naturalH / naturalW)
    return { width: Math.round(containerW), height: Math.round(height), fixedRatio: false }
  }

  const tallCap = Math.min(cap, MAX_IMAGE_HEIGHT)
  const scale = Math.min(1, tallCap / naturalH)
  return { width: Math.round(naturalW * scale), height: Math.round(naturalH * scale), fixedRatio: false }
}
