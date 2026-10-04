import type { MemorySnapshot } from './types.ts'

/** `performance.memory` 是 Chromium 专有、不在 TS 的 lib.dom 里，故自己声明。 */
interface ChromiumMemory {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

/**
 * 读 Chromium 的 heap 趋势指标。其它浏览器（以及 jsdom）没有这个 API —— 返回 null，
 * 记录器照常工作，只是样本里 memory 为空。诊断降级，绝不报错、绝不影响播放。
 *
 * null 表示「这个浏览器测不了」，不是「heap 为 0」。
 */
export function readMemory(): MemorySnapshot | null {
  const mem = (performance as unknown as { memory?: ChromiumMemory }).memory
  if (!mem || typeof mem.usedJSHeapSize !== 'number') return null
  return {
    usedJSHeapSize: mem.usedJSHeapSize,
    totalJSHeapSize: mem.totalJSHeapSize,
    jsHeapSizeLimit: mem.jsHeapSizeLimit,
  }
}

/** 没有 IndexedDB 就不启动记录器（隐私模式等）。 */
export function hasIndexedDB(): boolean {
  try {
    return typeof globalThis.indexedDB !== 'undefined' && globalThis.indexedDB !== null
  } catch {
    return false
  }
}
