// Present 官方注册表(甲档:用户不能带渲染代码,只能实例化官方模板)。
// 槽位真相源是 callsites.ts 的 entries 归组——这里只做聚合翻转,不双写。
// 前端持对应的 present id → 视图组件映射;二者靠 id 对齐。
import type { ChannelPresent, ProviderCategory } from '../store/types.ts'
import { PROVIDER_CALLSITES } from './callsites.ts'

export interface PresentSlot { callsiteId: string; label: string; category: ProviderCategory; mode: 'fixed' | 'dispatch' }

/** 取数形态。collected = 源→采集→item 库→读库；live = 请求到来时现执行、不落库。
 *  与 needsStreams 正交：search 是 false+live（什么都不绑），research 是 true+live（绑流但现读）。 */
export type PresentData = 'collected' | 'live'

export interface PresentDescriptor { id: ChannelPresent; label: string; needsStreams: boolean; data: PresentData; slots: PresentSlot[] }

// entryId = callsites.ts entries[].id;search 没有常驻采集也(暂)没有专属 entry 归组。
const BASE: Array<{ id: ChannelPresent; label: string; needsStreams: boolean; data: PresentData; entryId?: string }> = [
  { id: 'timeline', label: '时间线', needsStreams: true, data: 'collected', entryId: 'default-timeline' },
  { id: 'audio', label: '音乐', needsStreams: true, data: 'collected', entryId: 'music' },
  { id: 'video', label: '影视', needsStreams: true, data: 'collected', entryId: 'video' },
  { id: 'research', label: '研究', needsStreams: true, data: 'live' },
  { id: 'search', label: '搜索', needsStreams: false, data: 'live' },
  { id: 'tasks', label: '定时任务', needsStreams: false, data: 'live' },
  // 外接面板：一个频道 = 一张外部网页（options.url），整个主窗格一张 iframe。见
  // docs/superpowers/specs/2026-08-31-embed-present-design.md。
  { id: 'embed', label: '外接面板', needsStreams: false, data: 'live' },
]

const slotsFor = (entryId?: string): PresentSlot[] =>
  entryId
    ? PROVIDER_CALLSITES.filter((cs) => cs.entries.some((e) => e.id === entryId)).map((cs) => ({
        callsiteId: cs.id, label: cs.label, category: cs.category, mode: cs.mode,
      }))
    : []

export const PRESENTS: PresentDescriptor[] = BASE.map((p) => ({ id: p.id, label: p.label, needsStreams: p.needsStreams, data: p.data, slots: slotsFor(p.entryId) }))
export const presentDescriptor = (id: string): PresentDescriptor | undefined => PRESENTS.find((p) => p.id === id)
