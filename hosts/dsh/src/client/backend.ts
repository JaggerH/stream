/**
 * 浏览器半读那份由 host 半注入页面的常量（这条线为什么是这个形状，见 `src/wire.ts`）。
 */
import { STREAM_UI_GLOBAL, normalizeBackendUrl } from '../wire.ts'

/**
 * 读 Stream 后端地址。
 * @returns 归一化后的基址；页面上没有那份常量、或它畸形，返回 `undefined`。
 */
export function readBackendUrl(): string | undefined {
  const wire = (globalThis as Record<string, unknown>)[STREAM_UI_GLOBAL]
  if (typeof wire !== 'object' || wire === null) return undefined
  return normalizeBackendUrl((wire as { backendUrl?: unknown }).backendUrl)
}

/** 没配到时给用户看的那句人话（壳的主区与侧栏开关共用一份，别写两遍）。 */
export const BACKEND_MISSING_MESSAGE =
  'Stream 后端地址没有下发：工作台 profile 里 stream-ui 那一行缺少 streamBaseUrl，' +
  '页面上因此没有 __STREAM_UI__ 常量。内容面板与回 Stream 的链接停摆；对话与侧栏照常。'
