/** throw 出来的东西不保证是 Error —— `(e as Error).message` 对一个字符串/对象会得到字面量
 *  "undefined",把真正的失败原因整个吃掉(用户看到 `{"error":"undefined"}`)。
 *  凡是要把一个 catch 到的值变成人读文本的地方,都用这一个实现,别再各写各的。
 *
 *  cause 链逐层展开(` ← ` 连接,带 code 的附 `[CODE]`):undici 的 "fetch failed" 是个壳,
 *  真因(SocketError/UND_ERR_*)全在 cause 上——2026-07-23 网关 502 排障时 body 只有
 *  {"error":"fetch failed"},只能靠临时插桩找病根;展开后一条错误文本自己把链说全。
 *  深度上限 + 已访问集合双保险防成环(cause 可以指回自己)。 */
export function errText(e: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  for (let cur = e, depth = 0; cur != null && depth < 8 && !seen.has(cur); depth += 1) {
    seen.add(cur)
    parts.push(oneText(cur))
    cur = (cur as { cause?: unknown }).cause
  }
  return parts.join(' ← ')
}

function oneText(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as Error & { code?: unknown }).code
    return typeof code === 'string' && code.length > 0 ? `${e.message} [${code}]` : e.message
  }
  if (typeof e === 'string') return e
  try {
    return JSON.stringify(e) ?? String(e)
  } catch {
    return String(e)
  }
}
