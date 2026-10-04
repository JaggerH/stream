/**
 * `backend.health` 这一格的**唯一**判据 —— 探活路径怎么归一化、什么形状根本不受理。
 *
 * 为什么单独一个模块：这条路径被三处各自拼进 URL（provisioner 建容器后等健康、standby 名册
 * 拼 healthUrl、plugins 状态页探活），三处原本各写各的前导斜杠归一化。判据一分家就有一处会
 * 落下，而落下的那一处不会报错——它只是**拼出一个指向别处的 URL**。
 *
 * 真实的攻击面（终审 Important 1）：第三方写 `health: "@evil.com/"`，host 档的 origin 是
 * `http://127.0.0.1:<随机口>`，字符串拼接得到 `http://127.0.0.1:34567@evil.com/`——按 URL 文法
 * `127.0.0.1:34567` 是 userinfo，**host 是 evil.com**。于是宿主后端每秒对攻击者地址发一次 GET，
 * 一直发到 healthTimeout：一个装在别人机器上的内网探测原语。
 */

/**
 * 探活路径归一化：保证结果是一个**只能落在同一个 origin 上**的绝对路径。
 *
 * 两件事：补前导 `/`（`"health"` → `"/health"`），以及把多个前导斜杠塌成一个
 * （`"//evil.com/"` → `"/evil.com/"`）。后者是重点：`//evil.com/` 已经带前导斜杠，光判
 * `startsWith('/')` 放行，而 `new URL('//evil.com/', origin)` 会解析成**协议相对 URL**，
 * host 变成 evil.com。
 */
export function normalizeHealthPath(health: string | undefined): string {
  const raw = health ?? '/'
  return `/${raw.replace(/^\/+/, '')}`
}

/**
 * 这条 `health` 声明合不合法（第三方安装期用）。不合法返回给人看的原因，合法返回 null。
 *
 * 归一化能把畸形输入救回来，但对**第三方**不走"默默救回来"这条路：一个写了 `@evil.com/` 的包
 * 要么是在试探，要么是写错了，两种情况都该在安装期当面说清，而不是被悄悄改成
 * `/@evil.com/` 然后探一个必定 404 的路径。
 */
export function healthPathProblem(health: string): string | null {
  if (!health.startsWith('/')) {
    return `'${health}' 不是以 / 开头的路径`
  }
  if (health.startsWith('//')) {
    return `'${health}' 以 // 开头，那是协议相对 URL（host 会变成后面那一段），不是本机路径`
  }
  if (/[\s\\]/.test(health)) {
    return `'${health}' 含空白或反斜杠`
  }
  return null
}
