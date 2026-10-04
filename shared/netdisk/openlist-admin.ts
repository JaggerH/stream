/**
 * OpenList 的两个 admin 端点——Stream 的接管序列（`packages/alist/provision.ts`）与 DSH 网盘插件的
 * managed 档同吃一份。都是 `{code, data}` 信封，token 裸放 Authorization 头（无 Bearer）。
 */

/** POST /api/auth/login → 48h JWT。 */
export async function alistLogin(baseUrl: string, password: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const r = await fetchFn(`${baseUrl.replace(/\/$/, '')}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }),
  })
  const j = (await r.json()) as { code: number; message?: string; data?: { token?: string } }
  if (!r.ok || j.code !== 200 || !j.data?.token) throw new Error(`[alist] login 失败: ${j.code} ${j.message ?? ''}`)
  return j.data.token
}

/**
 * 读 OpenList 的**永久 token**（`x_setting_items.token`，设置页「令牌」那一格）。拿 admin JWT 去
 * `GET /api/admin/setting/get?key=token`。
 *
 * 为什么要它：递给 DSH 网盘插件 / 插件自己存下来的 token 必须是永久的（netdisk spec §5.3）——插件侧
 * 没有 Stream 的「401 自动重登」通道，48h JWT 过期就是静默断连。code 非 200 → throw 带 code；JWT 过期
 * 是 401，调用方据此重登一次再来。
 */
export async function fetchPermanentToken(baseUrl: string, jwt: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const r = await fetchFn(`${baseUrl.replace(/\/$/, '')}/api/admin/setting/get?key=token`, { headers: { authorization: jwt } })
  const j = (await r.json()) as { code: number; message?: string; data?: { value?: string } }
  if (!r.ok || j.code !== 200 || !j.data?.value) throw new Error(`[alist] 读永久 token 失败: ${j.code} ${j.message ?? ''}`)
  return j.data.value
}
