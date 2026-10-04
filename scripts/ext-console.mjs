#!/usr/bin/env node
/**
 * 读扩展后台（service worker）的控制台，打到终端。
 *
 *   node scripts/ext-console.mjs     # = pnpm ext:console
 *
 * 扩展连不上后端时，它往 debug bus 写日志的那条路也断了，控制台是唯一还在的现场。
 * 这条走 `POST /api/extension/console`（一条桌面 recipe，`src/browser/extension-console.ts`）：
 * Stream Desktop 开扩展详情页 → 点「Service Worker」→ 按 a11y 读 DevTools 里的每条消息。不经中继。
 */
const BASE = process.env.STREAM_BACKEND_URL ?? 'http://127.0.0.1:8900'

export async function readExtensionConsole(base = BASE) {
  const res = await fetch(`${base}/api/extension/console`, { method: 'POST' })
  return res.json()
}

export function printConsole(out) {
  if (out.status !== 'ok') {
    console.error(`[ext-console] 没读到：${JSON.stringify(out)}`)
    return false
  }
  if (!out.messages.length) console.log('[ext-console] 控制台是空的')
  for (const m of out.messages) console.log(`[${m.level}] ${m.text}`)
  return true
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!printConsole(await readExtensionConsole())) process.exit(1)
}
