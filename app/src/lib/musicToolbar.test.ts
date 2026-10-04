import { describe, it, expect } from 'vitest'
import {
  toolbarMenuItems, planDownloadAll, planExportTarget, autoDownloadEnabled, pickListRows, pickDownloadTargets, downloadBatchMessage,
  type ToolbarCaps,
} from './musicToolbar.ts'

// 顶部工具栏收敛的全部意义在于「三种列表按钮位置恒定，差异只沉到菜单里」。
// 菜单内容是这条约束唯一会变的地方，所以它值一份独立的纯函数单测——
// Radix 菜单在 jsdom 里打不开（监听 pointerdown，仓库只有 fireEvent.click），
// 靠渲染断言测不了。

const NONE: ToolbarCaps = {
  downloadAll: false, sync: null, netdisk: false, rename: false, remove: false, exportM3u: false,
}
const keys = (caps: ToolbarCaps) => toolbarMenuItems(caps).map((e) => e.key)

describe('toolbarMenuItems', () => {
  // 网盘是**一项**，不许再拆出第二项网盘动作——用户在点之前分不清自己该点哪个，而面板自己
  // 会先说该走哪条（NetdiskAdvice）。
  it('普通歌单：下载整单 / 保持同步 / 网盘，没有分隔线', () => {
    const caps: ToolbarCaps = { ...NONE, downloadAll: true, sync: { on: false }, netdisk: true }
    expect(keys(caps)).toEqual(['downloadAll', 'sync', 'netdisk'])
  })

  it('网盘那一项的字面就叫「网盘」（不再是两项）', () => {
    expect(toolbarMenuItems({ ...NONE, netdisk: true })).toEqual([{ kind: 'item', key: 'netdisk', label: '网盘' }])
  })

  it('播单：下载整单 + 分隔线 + 重命名 / 删除', () => {
    const caps: ToolbarCaps = { ...NONE, downloadAll: true, rename: true, remove: true }
    expect(keys(caps)).toEqual(['downloadAll', 'sep', 'rename', 'remove'])
  })

  it('我喜欢的：只有下载整单，不带分隔线', () => {
    expect(keys({ ...NONE, downloadAll: true })).toEqual(['downloadAll'])
  })

  it('一项都没有 → 空数组（调用方据此不渲染 ⋯）', () => {
    expect(toolbarMenuItems(NONE)).toEqual([])
  })

  it('保持同步是 checkbox，勾选态跟 sync.on 走', () => {
    const on = toolbarMenuItems({ ...NONE, sync: { on: true } })[0]
    expect(on).toEqual({ kind: 'checkbox', key: 'sync', label: '自动下载新曲目', checked: true })
    const off = toolbarMenuItems({ ...NONE, sync: { on: false } })[0]
    expect(off).toMatchObject({ kind: 'checkbox', checked: false })
  })

  it('删除是 destructive', () => {
    expect(toolbarMenuItems({ ...NONE, remove: true })[0]).toEqual({
      kind: 'item', key: 'remove', label: '删除播单', destructive: true,
    })
  })
})

describe('toolbarMenuItems — exportM3u', () => {
  const baseCaps: ToolbarCaps = {
    downloadAll: false, sync: null, netdisk: false,
    rename: false, remove: false, exportM3u: false,
  }

  it('adds a 生成 m3u item when exportM3u is on', () => {
    const entries = toolbarMenuItems({ ...baseCaps, exportM3u: true })
    expect(entries).toContainEqual({ kind: 'item', key: 'exportM3u', label: '生成 m3u' })
  })

  it('does not add it when exportM3u is off', () => {
    const entries = toolbarMenuItems(baseCaps)
    expect(entries.find((e) => e.kind === 'item' && e.key === 'exportM3u')).toBeUndefined()
  })
})

describe('planDownloadAll', () => {
  it('普通歌单且没有 chip 收窄 → 走整单端点（一次请求，比逐行便宜）', () => {
    expect(planDownloadAll({ isCollection: false, isLikedPlaylist: false, scopeId: null, streamId: 's1' }))
      .toEqual({ kind: 'stream', streamId: 's1' })
  })

  it('chip 收窄了 → 逐行（整单端点没法只下这一段）', () => {
    expect(planDownloadAll({ isCollection: false, isLikedPlaylist: false, scopeId: 'c9', streamId: 's1' }))
      .toEqual({ kind: 'rows' })
  })

  it('播单背后没有 stream → 逐行', () => {
    expect(planDownloadAll({ isCollection: true, isLikedPlaylist: false, scopeId: null, streamId: null }))
      .toEqual({ kind: 'rows' })
  })

  it('我喜欢的背后没有 stream → 逐行', () => {
    expect(planDownloadAll({ isCollection: false, isLikedPlaylist: true, scopeId: null, streamId: null }))
      .toEqual({ kind: 'rows' })
  })

  it('streamId 缺失时不许伪造整单请求', () => {
    expect(planDownloadAll({ isCollection: false, isLikedPlaylist: false, scopeId: null, streamId: null }))
      .toEqual({ kind: 'rows' })
  })
})

describe('pickListRows', () => {
  // 「下载整单」和 L2 搜索过滤共用这一条判定规则；两边一旦各写一份 `??` 链、
  // 手改跑偏，「下载整单」就会悄悄操作一批和列表实际显示不一致的曲目。
  const collectionRows = ['c1', 'c2']
  const scopeRows = ['s1', 's2']
  const likedRows = ['l1', 'l2']
  const tableRows = ['t1', 't2']

  it('collectionRows 非空 → 优先于其余所有', () => {
    expect(pickListRows({ collectionRows, scopeRows, isLikedPlaylist: true, likedRows, tableRows }))
      .toEqual(collectionRows)
    expect(pickListRows({ collectionRows, scopeRows, isLikedPlaylist: false, likedRows, tableRows }))
      .toEqual(collectionRows)
  })

  it('collectionRows 是非 null 的空数组 → 直接赢，不落到 scopeRows（空播单必须下载 0 首）', () => {
    expect(pickListRows({ collectionRows: [], scopeRows, isLikedPlaylist: false, likedRows, tableRows }))
      .toEqual([])
  })

  it('collectionRows 为 null、scopeRows 非空 → 用 scopeRows，不管 isLikedPlaylist', () => {
    expect(pickListRows({ collectionRows: null, scopeRows, isLikedPlaylist: true, likedRows, tableRows }))
      .toEqual(scopeRows)
    expect(pickListRows({ collectionRows: null, scopeRows, isLikedPlaylist: false, likedRows, tableRows }))
      .toEqual(scopeRows)
  })

  it('scopeRows 是非 null 的空数组 → 直接赢，不落到 liked/table（chip 收窄出 0 条也是 0 条）', () => {
    expect(pickListRows({ collectionRows: null, scopeRows: [], isLikedPlaylist: true, likedRows, tableRows }))
      .toEqual([])
  })

  it('collectionRows 和 scopeRows 都是 null、isLikedPlaylist=true → likedRows', () => {
    expect(pickListRows({ collectionRows: null, scopeRows: null, isLikedPlaylist: true, likedRows, tableRows }))
      .toEqual(likedRows)
  })

  it('collectionRows 和 scopeRows 都是 null、isLikedPlaylist=false → tableRows', () => {
    expect(pickListRows({ collectionRows: null, scopeRows: null, isLikedPlaylist: false, likedRows, tableRows }))
      .toEqual(tableRows)
  })
})

describe('pickDownloadTargets', () => {
  type Row = { id: string; can: boolean }
  const canDownload = (r: Row) => r.can
  const idOf = (r: Row) => r.id
  const rows: Row[] = [
    { id: 'a', can: true },
    { id: 'b', can: false },
    { id: 'c', can: true },
    { id: 'd', can: true },
  ]

  it('下载整单：全都能下 → 全进 targets，skipped 为 0', () => {
    const only = rows.filter((r) => r.can)
    expect(pickDownloadTargets({ rows: only, canDownload })).toEqual({ targets: only, skipped: 0 })
  })

  it('下载整单：混着下不了的行 → 只下能下的，skipped 记住被跳过的数目', () => {
    const r = pickDownloadTargets({ rows, canDownload })
    expect(r.targets.map(idOf)).toEqual(['a', 'c', 'd'])
    expect(r.skipped).toBe(1)
  })

  it('下载整单：一行都下不了 → targets 空，skipped = 全部（调用方据此报错而不是发 0 个请求）', () => {
    const none: Row[] = [{ id: 'x', can: false }, { id: 'y', can: false }]
    expect(pickDownloadTargets({ rows: none, canDownload })).toEqual({ targets: [], skipped: 2 })
  })

  it('多选：只认 selection.ids 里的行', () => {
    const r = pickDownloadTargets({ rows, canDownload, selection: { ids: new Set(['a', 'd']), idOf } })
    expect(r.targets.map(idOf)).toEqual(['a', 'd'])
    expect(r.skipped).toBe(0)
  })

  it('多选：选中里有下不了的 → skipped 只数选中的那部分,不数没选的', () => {
    const r = pickDownloadTargets({ rows, canDownload, selection: { ids: new Set(['a', 'b']), idOf } })
    expect(r.targets.map(idOf)).toEqual(['a'])
    expect(r.skipped).toBe(1)
  })

  it('多选：selection.ids 覆盖全部能下的行时,三首都进 targets、skipped 为 0', () => {
    const r = pickDownloadTargets({ rows, canDownload, selection: { ids: new Set(['a', 'c', 'd']), idOf } })
    expect(r.targets.map(idOf)).toEqual(['a', 'c', 'd'])
    expect(r.skipped).toBe(0)
  })
})

describe('downloadBatchMessage', () => {
  it('全部成功 → 只报成功数', () => {
    expect(downloadBatchMessage({ succeeded: 5, failed: 0, skipped: 0 }))
      .toEqual({ kind: 'success', text: '已加入下载队列：5 首' })
  })

  it('有跳过的 → 成功数 + 无可下载来源的数目', () => {
    expect(downloadBatchMessage({ succeeded: 4, failed: 0, skipped: 2 }))
      .toEqual({ kind: 'success', text: '已加入下载队列：4 首（2 首无可下载来源）' })
  })

  it('部分失败 → 失败数要说出来,不能只报成功的那几首', () => {
    expect(downloadBatchMessage({ succeeded: 3, failed: 2, skipped: 0 }))
      .toEqual({ kind: 'success', text: '已加入下载队列：3 首（2 首失败）' })
  })

  it('既有失败又有跳过 → 两条都点名', () => {
    expect(downloadBatchMessage({ succeeded: 3, failed: 2, skipped: 1 }))
      .toEqual({ kind: 'success', text: '已加入下载队列：3 首（2 首失败，1 首无可下载来源）' })
  })

  it('一首都没成功(后端挂了) → 红字,不许再弹绿的', () => {
    expect(downloadBatchMessage({ succeeded: 0, failed: 7, skipped: 0 }))
      .toEqual({ kind: 'error', text: '加入下载队列失败（7 首失败）' })
  })

  // 「已经下载过」和「没有可下载来源」是两种完全不同的处境,不能合并成一个数字:
  // 前者是"你已经有了",后者是"这首拿不到"。
  it('部分已下载过 → 和无来源分开点名', () => {
    expect(downloadBatchMessage({ succeeded: 2, failed: 0, skipped: 1, archived: 26 }))
      .toEqual({ kind: 'success', text: '已加入下载队列：2 首（26 首已下载过，1 首无可下载来源）' })
  })

  it('整份都已经下载过 → 绿字说清楚,不是失败', () => {
    expect(downloadBatchMessage({ succeeded: 0, failed: 0, skipped: 0, archived: 29 }))
      .toEqual({ kind: 'success', text: '这 29 首都已经下载过了' })
  })

  // 什么都没失败就不许弹红字——否则「你早就下过了」会被显示成一次故障。
  it('没排上队但也没失败 → 绿字说没事可做', () => {
    expect(downloadBatchMessage({ succeeded: 0, failed: 0, skipped: 3, archived: 5 }))
      .toEqual({ kind: 'success', text: '没有需要下载的（5 首已下载过，3 首无可下载来源）' })
  })

  it('真失败了才红 → 已下载过的数目也一并交代', () => {
    expect(downloadBatchMessage({ succeeded: 0, failed: 2, skipped: 0, archived: 5 }))
      .toEqual({ kind: 'error', text: '加入下载队列失败（2 首失败，5 首已下载过）' })
  })

  it('不传 archived 时行为不变(老调用方)', () => {
    expect(downloadBatchMessage({ succeeded: 1, failed: 0, skipped: 0 }))
      .toEqual({ kind: 'success', text: '已加入下载队列：1 首' })
  })
})

describe('autoDownloadEnabled', () => {
  it('options.autoDownload 为 true → true', () => {
    expect(autoDownloadEnabled({ options: { autoDownload: true } })).toBe(true)
  })

  it('options.autoDownload 缺省或 false → false', () => {
    expect(autoDownloadEnabled({ options: {} })).toBe(false)
    expect(autoDownloadEnabled({ options: { autoDownload: false } })).toBe(false)
  })

  it('stream 本身还没到货(null/undefined)→ false，不是抛错', () => {
    expect(autoDownloadEnabled(null)).toBe(false)
    expect(autoDownloadEnabled(undefined)).toBe(false)
  })
})

describe('planExportTarget', () => {
  it('普通 Stream 的 L2 → 导出这个 stream', () => {
    expect(planExportTarget({ isCollection: false, isLikedPlaylist: false, streamId: 's1', collectionId: null }))
      .toEqual({ kind: 'stream', id: 's1' })
  })

  it('Collection(播单)的 L2 → 导出这个 collection', () => {
    expect(planExportTarget({ isCollection: true, isLikedPlaylist: false, streamId: null, collectionId: 'col1' }))
      .toEqual({ kind: 'collection', id: 'col1' })
  })

  it('我喜欢的 → 不导出(v1 范围之外,没有接线)', () => {
    expect(planExportTarget({ isCollection: false, isLikedPlaylist: true, streamId: null, collectionId: null }))
      .toBeNull()
  })

  it('两个 id 都还没到货(channels 异步加载中的窗口)→ 不导出', () => {
    expect(planExportTarget({ isCollection: false, isLikedPlaylist: false, streamId: null, collectionId: null }))
      .toBeNull()
  })
})
