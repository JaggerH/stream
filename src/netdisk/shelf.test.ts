import { describe, it, expect } from 'vitest'
import { AlistClient } from '../../shared/netdisk/alist-client.ts'
import { OPENLIST_TRAITS } from './shelf.ts'

describe('shelf traits', () => {
  it('AlistClient 自报 OpenList 那份自述表（网盘有回收站、列举有缓存、名字区分大小写）', () => {
    const c = new AlistClient({ baseUrl: 'http://x', token: 't' })
    expect(c.traits).toEqual(OPENLIST_TRAITS)
    expect(c.traits).toMatchObject({ hasTrash: true, listingIsLive: false, caseSensitive: true, reportsInProgress: false })
  })

  // 决定账本的键拿它当前缀：改了 = 这个货架的存量决定整批掉钉。
  it('AlistClient 的货架 id 钉死为 openlist', () => {
    expect(new AlistClient({ baseUrl: 'http://x', token: 't' }).id).toBe('openlist')
  })
})
