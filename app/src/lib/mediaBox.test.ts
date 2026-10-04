import { describe, it, expect } from 'vitest'
import { computeMediaBox, resolveMediaDims, MAX_IMAGE_HEIGHT, MAX_MEDIA_HEIGHT, MAX_RATIO, PORTRAIT_RATIO, FIXED_RATIO } from './mediaBox.ts'

const W = 600 // column width
const CAP = 507 // height cap (px)
const IMAGE_CAP = 510

describe('computeMediaBox — video sizing', () => {
  it('uses the stable 9:16 frame for a 9:16 clip', () => {
    expect(computeMediaBox({ naturalW: 1080, naturalH: 1920, containerW: W, maxHeight: CAP, kind: 'video' })).toEqual({
      width: 285,
      height: 507,
      fixedRatio: true,
    })
  })

  it('uses the same 9:16 frame for a 3:4 mobile cover', () => {
    const cover = computeMediaBox({ naturalW: 330, naturalH: 440, containerW: 490, maxHeight: 507, kind: 'video' })
    expect(cover).toEqual({
      width: 285,
      height: 507,
      fixedRatio: true,
    })
  })

  it('uses the same 9:16 frame for a very tall screenshot', () => {
    expect(computeMediaBox({ naturalW: 1080, naturalH: 3000, containerW: W, maxHeight: CAP, kind: 'video' })).toEqual({
      width: 285,
      height: 507,
      fixedRatio: true,
    })
  })

  it('uses the default height cap when omitted', () => {
    expect(computeMediaBox({ naturalW: 1080, naturalH: 1920, containerW: W, kind: 'video' })).toEqual({
      width: 285,
      height: 507,
      fixedRatio: true,
    })
  })

  it('fits inside a narrow column', () => {
    const box = computeMediaBox({ naturalW: 720, naturalH: 1280, containerW: 200, maxHeight: CAP, kind: 'video' })
    expect(box.width).toBe(200)
    expect(box.height).toBe(356)
    expect(box.fixedRatio).toBe(true)
  })

  it('fills the width with a 16:9 frame for a 16:9 clip', () => {
    expect(computeMediaBox({ naturalW: 1600, naturalH: 900, containerW: W, maxHeight: CAP, kind: 'video' })).toEqual({
      width: 600,
      height: 338,
      fixedRatio: true,
    })
  })

  it('uses the same 16:9 frame for 5:4 landscape', () => {
    const box = computeMediaBox({ naturalW: 1350, naturalH: 1080, containerW: W, maxHeight: CAP, kind: 'video' }) // 5:4
    expect(box).toEqual({
      width: 600,
      height: 338,
      fixedRatio: true,
    })
  })

  it('uses the same 16:9 frame for a small landscape video', () => {
    expect(computeMediaBox({ naturalW: 200, naturalH: 150, containerW: W, maxHeight: CAP, kind: 'video' })).toEqual({
      width: 600,
      height: 338,
      fixedRatio: true,
    })
  })

  it('treats a square as tall media', () => {
    expect(computeMediaBox({ naturalW: 1000, naturalH: 1000, containerW: W, maxHeight: CAP, kind: 'video' })).toEqual({
      width: 285,
      height: 507,
      fixedRatio: true,
    })
  })
})

describe('computeMediaBox — ultra-wide media uses the stable wide frame', () => {
  it('uses the same 16:9 frame for an ultra-wide panorama', () => {
    expect(computeMediaBox({ naturalW: 4000, naturalH: 800, containerW: W, maxHeight: CAP, kind: 'video' })).toEqual({
      width: 600,
      height: 338,
      fixedRatio: true,
    })
  })

  it('keeps the MAX_RATIO boundary in the wide frame', () => {
    const box = computeMediaBox({ naturalW: 500 * MAX_RATIO, naturalH: 500, containerW: W, maxHeight: CAP, kind: 'video' })
    expect(box.fixedRatio).toBe(true)
  })
})

describe('computeMediaBox — image sizing', () => {
  it('fills the width for a wide image and preserves the natural ratio', () => {
    expect(computeMediaBox({ naturalW: 1600, naturalH: 900, containerW: W, maxHeight: IMAGE_CAP, kind: 'image' })).toEqual({
      width: 600,
      height: 338,
      fixedRatio: false,
    })
  })

  it('does not force a wide image into the video frame ratio', () => {
    expect(computeMediaBox({ naturalW: 1350, naturalH: 1080, containerW: W, maxHeight: IMAGE_CAP, kind: 'image' })).toEqual({
      width: 600,
      height: 480,
      fixedRatio: false,
    })
  })

  it('caps a tall image at 510px and scales proportionally', () => {
    expect(computeMediaBox({ naturalW: 1080, naturalH: 1920, containerW: W, maxHeight: IMAGE_CAP, kind: 'image' })).toEqual({
      width: 287,
      height: 510,
      fixedRatio: false,
    })
  })

  it('keeps a tall image smaller when its natural height is already within the cap', () => {
    expect(computeMediaBox({ naturalW: 330, naturalH: 440, containerW: W, maxHeight: IMAGE_CAP, kind: 'image' })).toEqual({
      width: 330,
      height: 440,
      fixedRatio: false,
    })
  })
})

describe('computeMediaBox — fallbacks & cap', () => {
  it('uses a full-width 16:9 placeholder when dimensions are unknown', () => {
    expect(computeMediaBox({ naturalW: 0, naturalH: 0, containerW: W, maxHeight: CAP })).toEqual({
      width: 600,
      height: 338,
      fixedRatio: false,
    })
  })

  it('caps the placeholder height when the container is wide', () => {
    expect(computeMediaBox({ naturalW: NaN, naturalH: NaN, containerW: 1200, maxHeight: 200 })).toEqual({
      width: 1200,
      height: 200,
      fixedRatio: false,
    })
  })

  it('returns an empty box before the container is measured', () => {
    expect(computeMediaBox({ naturalW: 800, naturalH: 600, containerW: 0, maxHeight: CAP })).toEqual({
      width: 0,
      height: 0,
      fixedRatio: false,
    })
  })

  it('defaults maxHeight to MAX_MEDIA_HEIGHT when omitted', () => {
    const a = computeMediaBox({ naturalW: 1080, naturalH: 1920, containerW: W, kind: 'video' })
    const b = computeMediaBox({ naturalW: 1080, naturalH: 1920, containerW: W, maxHeight: MAX_MEDIA_HEIGHT, kind: 'video' })
    expect(a).toEqual(b)
  })

  it('defaults image maxHeight to MAX_IMAGE_HEIGHT when omitted', () => {
    const a = computeMediaBox({ naturalW: 1080, naturalH: 1920, containerW: W, kind: 'image' })
    const b = computeMediaBox({ naturalW: 1080, naturalH: 1920, containerW: W, maxHeight: MAX_IMAGE_HEIGHT, kind: 'image' })
    expect(a).toEqual(b)
  })
})

describe('resolveMediaDims — video dimensions win over the poster', () => {
  it('prefers the real video size over a (differently-shaped) poster measurement', () => {
    expect(resolveMediaDims({ w: 1280, h: 720 }, { w: 720, h: 1280 })).toEqual({ w: 1280, h: 720 })
  })

  it('falls back to the poster size until the video size is known', () => {
    expect(resolveMediaDims(null, { w: 720, h: 1280 })).toEqual({ w: 720, h: 1280 })
    expect(resolveMediaDims(undefined, { w: 720, h: 1280 })).toEqual({ w: 720, h: 1280 })
  })

  it('ignores degenerate (zero) sizes from either source', () => {
    expect(resolveMediaDims({ w: 0, h: 0 }, { w: 720, h: 1280 })).toEqual({ w: 720, h: 1280 })
    expect(resolveMediaDims({ w: 1280, h: 720 }, { w: 0, h: 0 })).toEqual({ w: 1280, h: 720 })
  })

  it('returns null when nothing is known yet', () => {
    expect(resolveMediaDims(null, null)).toBeNull()
    expect(resolveMediaDims(undefined, undefined)).toBeNull()
  })
})

describe('computeMediaBox — exported presets', () => {
  it('keeps legacy constants available while using contain sizing for known media', () => {
    expect(FIXED_RATIO).toBeCloseTo(16 / 9, 5)
    expect(PORTRAIT_RATIO).toBeCloseTo(9 / 16, 5)
    expect(MAX_RATIO).toBeGreaterThan(1)
    expect(MAX_MEDIA_HEIGHT).toBeGreaterThan(0)
  })
})
