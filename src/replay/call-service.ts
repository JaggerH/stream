/**
 * `call` 步骤的出口：**把一个服务名解析成一个真实地址，然后打一发**。
 *
 * 这个文件存在的全部理由，是那一格的第 1 条边界（见 `src/replay/recipe.ts` 里 `call` 的
 * 头注）：**recipe 只给得出一个服务名，给不出地址**。地址怎么来是宿主的事——它去问
 * `pluginTarget()`，那是本仓唯一知道"某个包声明的后端此刻在哪"的地方。recipe 里根本没有一个
 * 字段能写 URL，所以第三方 recipe 没有"把页面上的东西发到我的服务器"这条路。
 *
 * 两条实现上的硬要求：
 *
 * 1. **地址必须在 `withAwake` 里面现解析。** host 档（主路常态）下容器是 standby 管着的，
 *    它的 loopback 口**只在醒着时存在**；在回调外面解析等于拿一个开机那一刻的快照，而那一刻
 *    多半还是空的。本仓已经为"装配期取的值 = 冻住的答案"栽过好几次（见 AGENTS.md 同名一节），
 *    这里不重蹈。
 * 2. **解析不到就抛，不返回空。** 静默失败会让 `call` 那一步绑不上，而下一步会拿着字面量
 *    `{code}` 去填表——站点只回一句"验证码错"，排查时看起来像识别不准，实际是容器压根没起来。
 */
import { pluginTarget } from '../plugins/plugin-target.ts'
import { withAwake } from '../plugins/standby/hook.ts'

/** 一发 call 的上限。OCR 这类端点按契约是**秒级、无状态、可重放**的
 *  （`docs/PACKAGE.md` §4.2），慢过这个数就是它病了，不是"再等等"。 */
const CONSULT_TIMEOUT_MS = 15_000

export async function callPluginService(
  service: string,
  path: string,
  /** `image` 恒在；其余键来自 recipe 的 `call.options`（字面量，装载期已拒插值）。 */
  body: { image: string } & Record<string, string | number | boolean>,
): Promise<unknown> {
  return await withAwake(service, async () => {
    // 现解析，不缓存——理由见头注第 1 条。
    const base = pluginTarget(service)
    if (!base) {
      throw new Error(
        `call：服务 "${service}" 解析不到地址。要么没有包声明这个 stream.backend.service，` +
        `要么它的容器没起来（\`pnpm plugins compose > docker-compose.yml && docker compose up -d ${service}\`）`
      )
    }
    const url = `${base.replace(/\/$/, '')}${path}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CONSULT_TIMEOUT_MS),
    })
    if (!res.ok) {
      // 带上一小段 body：这类服务的 4xx 通常自己说了原因（图太小、格式不认），
      // 只报一个状态码会让人去猜。
      const said = await res.text().catch(() => '')
      throw new Error(`call ${service}${path} → ${res.status} ${said.slice(0, 200)}`)
    }
    return await res.json()
  })
}
