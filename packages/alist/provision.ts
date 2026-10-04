import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { COMPOSE_SERVICE_LABEL } from '../../src/plugins/standby/docker-api.ts'

const execFileP = promisify(execFile)

/**
 * Bootstrap 接管序列（决策 2026-07-08：内置托管是唯一形态）。
 *
 * AList 是实现细节：admin 密码由 Stream 生成并接管，用户永远不接触 AList UI/凭证。
 * 序列（幂等）：
 *   1. 已有存储密码 → 直接 login 换新 48h JWT（跑两遍不重设密码）；
 *   2. login 失败（volume 重建导致密码漂移）→ 容器内 `openlist admin set` 重设 → 再 login；
 *   3. 无存储密码 → 生成随机密码 → admin set → login；
 *   4. 密码 + token 持久化（settings.json alist 节点，与既有 token 同一安全域）。
 *
 * 调用方（bootstrap）负责就绪门控（health /ping 通过后才调用），本模块不做等待。
 */

export interface AlistCredentials {
  password: string
  token: string
}

export interface ProvisionDeps {
  /** AList base url（内网地址，如插件网关或 http://alist:5244） */
  baseUrl: string
  /** 已存凭证（settings.json alist 节点） */
  getStored: () => Partial<AlistCredentials>
  /** 持久化凭证 */
  save: (creds: AlistCredentials) => void
  /** 容器内重设 admin 密码（默认 docker exec，测试注入 mock） */
  execAdminSet: (password: string) => Promise<void>
  fetchFn?: typeof fetch
  genPassword?: () => string
}

/** 两个 admin 端点的本体在 `shared/netdisk/openlist-admin.ts`（网盘插件的 managed 档同吃）；这里沿用名字。 */
import { alistLogin, fetchPermanentToken } from '../../shared/netdisk/openlist-admin.ts'
export { alistLogin, fetchPermanentToken }

/** `execFile` 的最小面——测试注入假的，生产走 node:child_process。 */
export type ExecFileLike = (cmd: string, args: string[]) => Promise<{ stdout: string }>

/**
 * 宿主侧 docker exec 重设 admin 密码（openlistteam/openlist 镜像 workdir /opt/openlist，二进制 ./openlist）。
 *
 * 容器**按 compose service 标签找**，不按名字猜：同一个 service 在 dev（compose）下叫
 * `stream-alist-1`，在 release（standby 自建）下叫 `stream-alist`，两个都不叫 `alist`——
 * 曾经就是 `docker exec alist`，于是「login 失败 → 重设密码」这条路在两种模式下都从没通过，
 * 而单测注入的是假 exec，看不见。标签是两条建容器的路都会打的那一个（standby 建容器时
 * 显式写 `COMPOSE_SERVICE_LABEL`，compose 自己也打同名标签），所以它是唯一对两边都成立的键。
 */
export function dockerAdminSet(service = 'alist', exec: ExecFileLike = execFileP): (password: string) => Promise<void> {
  return async (password) => {
    const { stdout } = await exec('docker', ['ps', '-q', '--filter', `label=${COMPOSE_SERVICE_LABEL}=${service}`])
    const id = stdout.trim().split('\n')[0]?.trim()
    if (!id) throw new Error(`[alist] 找不到 service=${service} 的运行中容器（按 ${COMPOSE_SERVICE_LABEL} 标签查），无法重设 admin 密码`)
    await exec('docker', ['exec', id, './openlist', 'admin', 'set', password])
  }
}

/** 接管序列入口。返回可用 token；所有失败路径 throw（调用方决定降级策略）。 */
export async function provisionAlist(deps: ProvisionDeps): Promise<string> {
  const fetchFn = deps.fetchFn ?? fetch
  const gen = deps.genPassword ?? (() => randomBytes(18).toString('base64url'))
  const stored = deps.getStored()

  // 快路径：密码在手 → 只换 token，不动容器。
  if (stored.password) {
    try {
      const token = await alistLogin(deps.baseUrl, stored.password, fetchFn)
      deps.save({ password: stored.password, token })
      return token
    } catch {
      // 密码漂移（volume 重建/手动改过）→ 落到重设路径，用存储密码保持稳定。
    }
  }

  const password = stored.password ?? gen()
  await deps.execAdminSet(password)
  const token = await alistLogin(deps.baseUrl, password, fetchFn)
  deps.save({ password, token })
  return token
}
