import { describe, expect, it } from 'vitest'
import { loadRecipePackages } from './recipe-package.ts'
import { makeHttpFetch } from './http-fetch.ts'
import { interpretObject } from './interpret.ts'

// Live-only: hits pan.baidu.com. The alive-legs need a real share; supply
// BAIDU_LIVE_PWD_ID (the /s/1xxxx id) + BAIDU_LIVE_PASSCODE. The dead-link leg
// only needs STREAM_LIVE=1. Activation:
//   STREAM_LIVE=1 BAIDU_LIVE_PWD_ID=1xxxx BAIDU_LIVE_PASSCODE=abcd \
//     pnpm exec vitest run src/replay/baidu-http.integration.test.ts
const LIVE = process.env.STREAM_LIVE === '1'
const PWD_ID = process.env.BAIDU_LIVE_PWD_ID
const PASSCODE = process.env.BAIDU_LIVE_PASSCODE
const live = LIVE ? it : it.skip
const liveShare = LIVE && PWD_ID && PASSCODE ? it : it.skip

function loadBaidu() {
  const recipe = loadRecipePackages('packages').recipes.get('baidu-share')
  if (recipe?.kind !== 'http') throw new Error('baidu-share recipe not found / not http')
  return recipe
}

const run = (params: Record<string, string>) => {
  const recipe = loadBaidu()
  return interpretObject(recipe, { fetchInPage: makeHttpFetch(recipe) }, params) as Promise<{
    validity: string
    files: Array<{ name: string }>
    reason?: string
  }>
}

describe('baidu-share recipe 活体四态（live）', () => {
  liveShare('①真链+对码 → alive + 文件名', async () => {
    const r = await run({ pwd_id: PWD_ID!, passcode: PASSCODE! })
    expect(r.validity).toBe('alive')
    expect(r.files.length).toBeGreaterThan(0)
    expect(r.files[0].name).toBeTruthy()
  }, 30_000)

  liveShare('②错码 → unknown（链接可证明地在，绝不判死）', async () => {
    const wrong = PASSCODE!.slice(0, -1) + (PASSCODE!.endsWith('x') ? 'y' : 'x')
    const r = await run({ pwd_id: PWD_ID!, passcode: wrong })
    expect(r.validity).toBe('unknown')
  }, 30_000)

  liveShare('③无码 → unknown（看不进去 ≠ 死）', async () => {
    const r = await run({ pwd_id: PWD_ID! })
    expect(r.validity).toBe('unknown')
  }, 30_000)

  live('④假链 → not-usable（errno 140 是唯一诚实的死）', async () => {
    const r = await run({ pwd_id: '1aaaaaaaaaaaaaaaaaaaaaa', passcode: '0000' })
    expect(r.validity).toBe('not-usable')
  }, 30_000)
})
