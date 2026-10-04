import { describe, expect, it } from 'vitest'
import { HOST_ENRICH_SOURCES } from './index.ts'

describe('enrich dispatch', () => {
  // 宿主自留的分支只剩不属于任何一家站的 `link`；站点的评论 / 详情由自己的包交 enricher。
  it('HOST_ENRICH_SOURCES 与 switch 同一份：只有 link', () => {
    expect([...HOST_ENRICH_SOURCES]).toEqual(['link'])
  })
})
