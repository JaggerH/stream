/**
 * 一条通知 → 一段可以直接粘进对话框的纯文本。
 *
 * 为什么不是「复制正文」就完了：正文（`body`）是写给只做架构把关的人的白话，用户复制它是为了
 * **贴给 AI 排查**，而白话对排查没用。所以复制出去的必须自带现场：绝对时间、severity、type、
 * 完整正文（面板里那行是 `truncate` 的，这里绝不截断）、以及后端塞进来的 `detail`。
 */
import type { UiEvent } from './EventsProvider.tsx'

const SEVERITY_CN: Record<UiEvent['severity'], string> = { info: '提示', warn: '警告', error: '错误' }

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * 本地绝对时间 `YYYY-MM-DD HH:mm:ss`。**不用"两分钟前"**：那种写法脱离了复制的那一刻就不可解，
 * 而这段文本的全部用途就是被搬到别处去读。手写而不是 `toLocaleString`，是为了格式在任何 locale
 * 下都一样 —— 排查时要跟日志对时刻，格式一漂就得先猜它是哪一种。
 */
export function absoluteTime(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function notificationCopyText(e: UiEvent): string {
  const lines = [
    `[${e.severity} / ${SEVERITY_CN[e.severity]}] ${e.type}`,
    `时间：${absoluteTime(e.at)}`,
    `标题：${e.title}`,
  ]
  if (e.body) lines.push(`正文：${e.body}`)
  if (e.ref) lines.push(`关联：${e.ref.kind}=${e.ref.id}`)
  // 缺席就不留一个空标题 —— 一个后面什么都没有的「详情：」会被读成"现场是空的"。
  if (e.detail) lines.push('详情：', ...e.detail.split('\n').map((l) => `  ${l}`))
  return lines.join('\n')
}
