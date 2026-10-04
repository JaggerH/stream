import { describe, it, expect } from 'vitest'
import { buildStreamMemberFromIntent } from './from-intent.ts'
import type { Registry } from '../registry/registry.ts'

const fakeRegistry = (byId: Record<string, unknown>) =>
  ({ get: (id: string) => byId[id] ?? null }) as unknown as Registry

describe('buildStreamMemberFromIntent', () => {
  it('maps the top candidate to a {plugin, source, params} member using key_param', () => {
    const intent = { targetType: 'xhs-author', key: 'ABC123', candidates: ['xhs:author'] }
    const reg = fakeRegistry({ 'xhs:author': { id: 'xhs:author', key_param: 'user_id' } })
    expect(buildStreamMemberFromIntent(intent, reg)).toEqual({
      plugin: 'xhs', source: 'author', params: { user_id: 'ABC123' },
    })
  })

  it('defaults key_param to "url"', () => {
    const intent = { targetType: 'generic-url', key: 'https://x.com/p', candidates: ['browser:page'] }
    const reg = fakeRegistry({ 'browser:page': { id: 'browser:page' } })
    expect(buildStreamMemberFromIntent(intent, reg)).toEqual({
      plugin: 'browser', source: 'page', params: { url: 'https://x.com/p' },
    })
  })

  it('treats a bare (non-namespaced) source id as the custom plugin', () => {
    const intent = { targetType: 'hn', key: 'hn', candidates: ['hn'] }
    const reg = fakeRegistry({ hn: { id: 'hn' } })
    expect(buildStreamMemberFromIntent(intent, reg)).toEqual({
      plugin: 'custom', source: 'hn', params: { url: 'hn' },
    })
  })

  it('returns null when there are no candidates', () => {
    const intent = { targetType: 'unknown', key: 'hello', candidates: [] }
    expect(buildStreamMemberFromIntent(intent, fakeRegistry({}))).toBeNull()
  })
})
