import { describe, it, expect } from 'vitest'
import { buildTaskBook, buildValidationFeedback, parseUnrepairable, UNREPAIRABLE_MARKER } from './task-book.ts'

const base = {
  sourceId: '@streamapp/xhs/xhs-search', localSourceId: 'xhs-search', facility: 'xhs',
  reason: 'recipe produced no items', affectedSources: ['@streamapp/xhs/xhs-search', '@streamapp/xhs/xhs-home'],
  recipePath: '/w/xhs/xhs-search.recipe.json', currentVersion: 4,
  failureShots: ['/d/failures/xhs-search-1.jpg'], lastFailureAt: '2026-09-11T14:00:00Z',
  mcpToolNames: ['cdp_look', 'cdp_shot', 'cdp_act', 'cdp_pages'],
}

describe('buildTaskBook', () => {
  it('点名文件、目标版本、连累的源、禁令与产物要求', () => {
    const t = buildTaskBook(base)
    expect(t).toContain('/w/xhs/xhs-search.recipe.json')
    expect(t).toContain('version 改成 5')
    expect(t).toContain('@streamapp/xhs/xhs-home')
    expect(t).toContain('expect')
    expect(t).toContain('cdp_look')
    expect(t).toContain(UNREPAIRABLE_MARKER)
    expect(t).toContain('write-recipe')
  })
  it('没有截图、没人受连累时不编造', () => {
    const t = buildTaskBook({ ...base, failureShots: [], affectedSources: [base.sourceId], lastFailureAt: undefined })
    expect(t).not.toContain('截图')
    expect(t).not.toContain('跟着哑')
  })
})

describe('buildValidationFeedback', () => {
  it('只列没过的格，probe 的 skipped 档不算没过', () => {
    const f = buildValidationFeedback({ schema: 'ok', version: 'version 必须是 5，现在是 4', assertions: 'ok', probe: 'skipped-needs-params' })
    expect(f).toContain('version 必须是 5')
    expect(f).not.toContain('schema')
    expect(f).not.toContain('probe')
  })
})

describe('parseUnrepairable', () => {
  it('带标记 → 原因；不带 → null', () => {
    expect(parseUnrepairable(`分析完了。\n${UNREPAIRABLE_MARKER} 站点要求登录，游客态看不到搜索结果`)).toBe('站点要求登录，游客态看不到搜索结果')
    expect(parseUnrepairable('我改好了')).toBeNull()
  })
})
