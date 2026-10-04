import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { comparePosterBuffers } from './poster-similarity.ts'

const poster = (background: string, foreground: string) => Buffer.from(
  `<svg width="300" height="450" xmlns="http://www.w3.org/2000/svg"><rect width="300" height="450" fill="${background}"/><circle cx="150" cy="200" r="110" fill="${foreground}"/><rect x="40" y="330" width="220" height="45" fill="${foreground}"/></svg>`,
)

describe('poster similarity', () => {
  it('matches the same artwork across webp and jpeg encodings', async () => {
    const source = await sharp(poster('#1b2430', '#e7b10a')).webp({ quality: 55 }).toBuffer()
    const candidate = await sharp(poster('#1b2430', '#e7b10a')).jpeg({ quality: 80 }).toBuffer()

    await expect(comparePosterBuffers(source, candidate)).resolves.toBeGreaterThan(0.85)
  })

  it('separates visually different artwork', async () => {
    const source = await sharp(poster('#1b2430', '#e7b10a')).webp().toBuffer()
    const other = await sharp(poster('#f3e7d3', '#61210e')).jpeg().toBuffer()

    await expect(comparePosterBuffers(source, other)).resolves.toBeLessThan(0.8)
  })

  // A localized one-sheet keeps the key art and re-sets only the title. Most of the frame is a
  // flat field, which a gradient-sign hash reads as noise — that scored real matches like these
  // below unrelated posters. Similarity must survive the swapped title block.
  const localized = (title: string) => Buffer.from(
    `<svg width="300" height="450" xmlns="http://www.w3.org/2000/svg"><rect width="300" height="450" fill="#4a1f5e"/><rect x="20" y="10" width="260" height="90" fill="#d8c7e8"/><circle cx="90" cy="55" r="28" fill="#2b1038"/><circle cx="200" cy="55" r="28" fill="#2b1038"/><rect x="${title === 'wide' ? 30 : 90}" y="210" width="${title === 'wide' ? 240 : 120}" height="52" fill="#f0e6b8"/></svg>`,
  )

  it('matches the same key art when only the title treatment differs', async () => {
    const source = await sharp(localized('wide')).webp({ quality: 55 }).toBuffer()
    const candidate = await sharp(localized('narrow')).jpeg({ quality: 80 }).toBuffer()

    await expect(comparePosterBuffers(source, candidate)).resolves.toBeGreaterThan(0.6)
  })

  it('does not match unrelated artwork that merely shares a flat background', async () => {
    const source = await sharp(localized('wide')).webp().toBuffer()
    const unrelated = Buffer.from(
      '<svg width="300" height="450" xmlns="http://www.w3.org/2000/svg"><rect width="300" height="450" fill="#4a1f5e"/><rect x="0" y="300" width="300" height="150" fill="#0d0d0d"/></svg>',
    )

    await expect(comparePosterBuffers(source, await sharp(unrelated).jpeg().toBuffer())).resolves.toBeLessThan(0.6)
  })
})
