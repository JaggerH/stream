import type { StoredItem } from '../item-store.ts'

/**
 * **播放投影的产物**：条目此刻该怎么显示/怎么播，不是库里存了什么。
 *
 * 与 `StoredItem` 结构完全相同，只差品牌字段 `__shape` 的取值范围——闸门因此是**单向**的：
 *  · `StoredItem` → `PresentedItem`：放行（投影链的入口，`'stored'` 落在这里的取值集合里）；
 *  · `PresentedItem` → `StoredItem`：**编译错误**（`'presented'` 不在那一侧的取值集合里）。
 *
 * 谁产出它：`gateResolveOnlyMedia`（付费集未配上 → 音频换成封面图）、`gateResolveOnlyVideoMedia`
 * （绑定管着的分集 → media 换成 resolve 直链或禁用卡）。两者都会**丢掉**原条目的时长与 track_id。
 *
 * 所以：任何回答「库里存了什么」的代码（网盘整理的权威清单、匹配、账本）都只收 `StoredItem`，
 * 拿投影产物去判断必然得出假结论。要看整理管线眼里的权威清单，走
 * `GET /api/netdisk/reconcile/:show/authority`，别去读 `/api/items`。
 */
export type PresentedItem = Omit<StoredItem, '__shape'> & { readonly __shape?: 'stored' | 'presented' }
