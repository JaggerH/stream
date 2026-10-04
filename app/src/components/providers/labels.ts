import type { MemberHealth, ProviderCategory } from '../../lib/types.ts'

/** 左列 section 的固定顺序；加第 9 个类别只需在这里追加一项。 */
export const CATEGORIES: ProviderCategory[] = ['search', 'resolve', 'download', 'transform', 'transcribe', 'llm', 'metadata', 'images']

export const CATEGORY_LABEL: Record<ProviderCategory, string> = {
  search: '搜索', resolve: '解析', download: '下载', transform: '转换',
  transcribe: '转写', llm: 'LLM', metadata: '元数据', images: '图片',
}

export const STRATEGY_LABEL: Record<'sequential' | 'concurrent', string> = { sequential: '顺次', concurrent: '并发' }
export const MODE_LABEL: Record<'fixed' | 'dispatch', string> = { fixed: '固定', dispatch: '分发' }

export const HEALTH_CLASS: Record<MemberHealth, string> = {
  healthy: 'bg-emerald-500', degraded: 'bg-rose-500', unhealthy: 'bg-rose-500', unknown: 'bg-zinc-400',
}
export const HEALTH_LABEL: Record<MemberHealth, string> = {
  healthy: '健康', degraded: '异常', unhealthy: '异常', unknown: '未知',
}
export const KEY_STATE_LABEL: Record<'stored' | 'env' | 'missing', string> = {
  stored: '已配 key', env: 'env', missing: '缺 key',
}
