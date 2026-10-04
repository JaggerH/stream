import { describe, expect, it } from 'vitest'
import { loadRecipePackages } from './recipe-package.ts'
import { makeHttpFetch } from './http-fetch.ts'
import { interpret } from './interpret.ts'

/**
 * End-to-end over the REAL music.znnu.com: the isolated-vm sandbox signs the request with
 * zuna's own HMAC scheme and decrypts its AES-256-GCM response — no browser, no platform
 * signature forged (zuna is itself a third-party unlocker). This is the worked proof that
 * the compute hook works against a live signing/encrypting API.
 *
 * Network test — opt in with STREAM_LIVE=1.
 */
const live = process.env.STREAM_LIVE === '1' ? it : it.skip

const run = async (sourceId: string, params: Record<string, string>) => {
  const recipe = loadRecipePackages('packages').recipes.get(sourceId)
  expect(recipe?.kind).toBe('http')
  if (recipe?.kind !== 'http') throw new Error('not http')
  return (await interpret(recipe, { fetchInPage: makeHttpFetch(recipe) }, params)).items
}
const NETEASE_SONG = /^https:\/\/music\.163\.com\/song\?id=\d+$/

describe('zuna/toubiec compute + http recipes (live)', () => {
  // zuna: sandbox signs (HMAC) + decrypts (AES) a real search
  live('zuna-search signs + decrypts, yielding NetEase-linked items', async () => {
    const items = await run('zuna-search', { keyword: '周杰伦' })
    expect(items.length).toBeGreaterThan(5)
    expect(items[0].title).toBeTruthy()
    expect(String(items[0].link)).toMatch(NETEASE_SONG)
  }, 30_000)

  // zuna playlist: ONE signed request returns the FULL tracklist (no per-track resolve)
  live('zuna-playlist returns a large decrypted tracklist in one request', async () => {
    const items = await run('zuna-playlist', { id: '3222869790' }) // 796-track playlist
    expect(items.length).toBeGreaterThan(500)
    expect(items[0].title).toBeTruthy()
    expect(items[0].author).toBeTruthy()
    expect(String(items[0].link)).toMatch(NETEASE_SONG)
  }, 30_000)

  // zuna download: id → the real lossless CDN file url (what netease-track resolves on play)
  live('zuna-download resolves one song to a playable file url', async () => {
    const items = await run('zuna-download', { id: '5257138', level: 'lossless' })
    expect(items).toHaveLength(1)
    expect(String(items[0].enclosure_url)).toMatch(/music\.126\.net.*\.(flac|mp3)/)
    expect(items[0].title).toBeTruthy()
  }, 30_000)

  // toubiec: plaintext, no sandbox — search maps straight to items
  live('toubiec-search returns plaintext NetEase-linked items', async () => {
    const items = await run('toubiec-search', { keyword: '周杰伦' })
    expect(items.length).toBeGreaterThan(5)
    expect(items[0].title).toBeTruthy()
    expect(String(items[0].link)).toMatch(NETEASE_SONG)
  }, 30_000)

  // toubiec download: the netease-track ladder's first rung. Two things this pins that a
  // "url is non-empty" assertion would miss:
  //  1) VIP 曲也解得出来 —— 这正是第三方解析器存在的理由（游客态打官方接口只回 -110）。
  //  2) 曲目元数据齐全 —— 下游拿它写 ID3，缺了就是一堆没有歌手专辑封面的文件。
  live('toubiec-download resolves a VIP song to a lossless file url WITH metadata', async () => {
    const items = await run('toubiec-download', { id: '509781655', level: 'lossless' })
    expect(items).toHaveLength(1)
    expect(String(items[0].enclosure_url)).toMatch(/music\.126\.net.*\.(flac|mp3)/)
    expect(items[0].title).toBeTruthy()
    expect(items[0].author).toBeTruthy()
    expect(items[0].image).toBeTruthy()
  }, 30_000)

  // toubiec playlist: ONE request returns the whole tracklist (same shape as zuna's).
  live('toubiec-playlist returns a tracklist in one request', async () => {
    const items = await run('toubiec-playlist', { id: '3778678' })
    expect(items.length).toBeGreaterThan(10)
    expect(items[0].title).toBeTruthy()
    expect(String(items[0].link)).toMatch(NETEASE_SONG)
  }, 30_000)
})
