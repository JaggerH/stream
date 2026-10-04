import type { AudioSnapshot, DomSnapshot, MemorySnapshot, Sample } from './types.ts'

/** 全局 <audio> 的只读快照提供者。由 App.tsx 实现 —— recorder 不拥有该元素。 */
export type AudioProvider = () => AudioSnapshot | null

export interface SampleDeps {
  doc: Document
  route: string
  audio: AudioProvider
  memory: () => MemorySnapshot | null
  /** 返回 null = 未测量。别在没接观测器时返回 0 —— 那是往证据里掺假。 */
  longTasks: () => { count: number; totalMs: number } | null
  resourceEntries: () => number
}

/** DOM 规模。节点数持续上涨 = 前端在漏；稳定 = 往媒体/系统内存那边查。 */
export function readDom(doc: Document): DomSnapshot {
  return {
    nodes: doc.getElementsByTagName('*').length,
    img: doc.getElementsByTagName('img').length,
    video: doc.getElementsByTagName('video').length,
    audio: doc.getElementsByTagName('audio').length,
  }
}

/**
 * 拼一条样本。所有外部读取都经 deps 注入，故本函数可单测且无隐藏全局依赖。
 * 任何一路缺失（如无 memory API）都降级为 null，不抛 —— 诊断绝不能反过来搞崩页面。
 */
export function buildSample(sessionId: string, at: number, deps: SampleDeps): Sample {
  return {
    sessionId,
    at,
    memory: deps.memory(),
    dom: readDom(deps.doc),
    route: deps.route,
    visibility: deps.doc.visibilityState === 'hidden' ? 'hidden' : 'visible',
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    audio: deps.audio(),
    resourceEntries: deps.resourceEntries(),
    longTasks: deps.longTasks(),
  }
}
