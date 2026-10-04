import { describe, it, expect } from 'vitest'
import { authorityFromStream, bindingLeftFromStream } from './left-from-stream.ts'
import { gateResolveOnlyMedia } from '../content/paid-playability.ts'
import { gateResolveOnlyVideoMedia } from '../content/video-playability.ts'
import type { StoredItem } from '../item-store.ts'

/**
 * **类型级测试**：这些断言由 `tsc --noEmit` 判定，不是运行时判定——`@ts-expect-error` 那几行
 * 一旦不再报错，typecheck 就会红（"unused '@ts-expect-error' directive"）。
 *
 * 守的是：播放投影（`/api/items` 上那道付费集灰化）的产物**流不进整理管线**。它把付费集的音频
 * 整个换成封面图，时长与 track_id 随之消失；照它判"库里存了什么"必然得出假结论——真事故：
 * 21 条付费集被误判"无时长"。
 */

const storedItems = (): StoredItem[] => []

describe('权威清单只吃存储形状', () => {
  it('播放投影的产物赋不回存储形状（编译期拦截）', () => {
    authorityFromStream({
      // @ts-expect-error 音频投影的产物（PresentedItem[]）不是库存，喂不进权威清单
      recentItems: () => gateResolveOnlyMedia(storedItems()),
      shelfSourceIds: () => new Set<string>(),
    })
    authorityFromStream({
      // @ts-expect-error 视频投影的产物同理
      recentItems: () => gateResolveOnlyVideoMedia(storedItems()),
      shelfSourceIds: () => new Set<string>(),
    })
    bindingLeftFromStream({
      // @ts-expect-error 绑定左侧也只收库存
      recentItems: () => gateResolveOnlyMedia(storedItems()),
    })
    // 反方向照常放行：库存喂进投影是投影链自己的入口。
    expect(gateResolveOnlyMedia(storedItems())).toEqual([])
    // 存储形状本身当然进得去（品牌是可选的，构造点一律不必写它）。
    expect(authorityFromStream({ recentItems: storedItems, shelfSourceIds: () => new Set<string>() })('s').entries).toEqual([])
    expect(bindingLeftFromStream({ recentItems: storedItems })('s')).toEqual([])
  })
})
