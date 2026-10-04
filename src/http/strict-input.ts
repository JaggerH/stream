/**
 * 「你给的这个字段我不认识」—— 把静默丢弃换成一句能照着改的报错。
 *
 * 为什么需要它：一个 HTTP handler 只读自己认识的那几个键，**多出来的键连看都不看**。
 * 对着界面点的人撞不到（前端的字段名是写死的），但任何程序化调用方——agent、脚本、
 * 临时 curl——写错一个名字就会拿到 **200 + 一份看起来完全正常的响应**，没有任何信号
 * 告诉它"你要的事情根本没发生"。
 *
 * 活体代价（2026-08-24，一天之内三次）：
 *  - `GET /api/items?stream_id=…`（正确是 `stream`）→ 筛选没生效、返回全库，
 *    一个 agent 据此判定"采集器全局故障"并提议删流重建。
 *  - `PATCH /api/streams/:id` 传 `{sources}`（正确是 `members`）→ 返回 200 和一个完整的
 *    stream 对象，看上去和改成功一模一样；两次空操作之后还据此推出了一个错误的代码结论。
 *  - 同一次里订出一条 `source_template_id` 少了 `/:id` 的流：照单收下，成为一条永远采 0 条的流。
 *
 * 三次都是同一句话：**我说的话你没听见，但你点头了。** 所以报错必须带两样东西——
 * 「你写的是什么」和「你大概想写什么」，否则调用方只知道错了、不知道往哪改。
 */

/** 编辑距离 ≤ 这个数就当成"拼错了"，给出猜测。再远就不猜——瞎猜比不猜更误导。 */
const SUGGEST_MAX_DISTANCE = 3

/** 朴素编辑距离。键名都是十来个字符的短串，不值得为它引一个库。 */
function distance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1])
    }
    prev = cur
  }
  return prev[n]
}

/**
 * 最像的那个合法键名。**先看是不是"同一个名字的另一种写法"**（去掉下划线/连字符后相等，
 * 如 `stream_id` vs `streamId`、`source_id` vs `sourceId`）——这类是最常见的一种写错，
 * 而它们的编辑距离往往不小，纯按距离会漏掉。
 */
export function closestKey(given: string, allowed: readonly string[]): string | undefined {
  const norm = (s: string): string => s.toLowerCase().replace(/[_-]/g, '')
  const g = norm(given)
  const alias = allowed.find((k) => norm(k) === g)
  if (alias) return alias
  let best: string | undefined
  let bestD = Infinity
  for (const k of allowed) {
    const d = distance(given.toLowerCase(), k.toLowerCase())
    if (d < bestD) { bestD = d; best = k }
  }
  return bestD <= SUGGEST_MAX_DISTANCE ? best : undefined
}

/** 一句人话的报错。`kind` 只用来措辞（"查询参数" / "字段"）。 */
export function unknownKeyMessage(kind: '查询参数' | '字段', given: string, allowed: readonly string[]): string {
  const guess = closestKey(given, allowed)
  const hint = guess ? `——是不是想写 '${guess}'？` : '——它被忽略了，不是生效了。'
  return `不认识的${kind} '${given}'${hint} 这个接口接受的${kind}：${[...allowed].sort().join(', ')}`
}

/**
 * 检出请求里不被认识的键。返回 `null` = 全都认识。
 *
 * **故意返回第一个而不是全部**：报错是给人/agent 读的，一次指一个、带上猜测，比列一串更好改。
 */
export function unknownKey(given: Iterable<string>, allowed: readonly string[]): string | null {
  const ok = new Set(allowed)
  for (const k of given) if (!ok.has(k)) return k
  return null
}
