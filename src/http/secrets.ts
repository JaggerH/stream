import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'

/**
 * 落在 `data/` 里的共享 secret：首启生成 256-bit 随机值持久化（重启稳定），文件 0600。
 * 两个调用点（ext-relay / api）用的是**不同的文件**——见 loadOrCreateApiToken 的注释。
 */
function loadOrCreateSecret(dir: string, name: string): string {
  const file = join(dir, name)
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim()
    if (t) return t
  }
  mkdirSync(dirname(file), { recursive: true })
  const token = randomBytes(32).toString('hex')
  writeFileSync(file, token + '\n', { mode: 0o600 })
  chmodSync(file, 0o600) // 文件已存在但为空时 mode 选项不生效，补一手
  return token
}

/**
 * ext-relay 的共享 secret。**这个文件本身就是分发渠道**：扩展经 native messaging 让
 * stream-desktop 读它（同一个用户才读得到），后端从不把它发到网络上——`/api/ext/verify`
 * 只用它签 proof。用户全程不可见。
 */
export function loadOrCreateExtToken(dir: string): string {
  return loadOrCreateSecret(dir, 'ext-relay-token')
}

/**
 * 局域网访问 `/api/*` 与 `/ws` 要出示的 token（本机 loopback 免密，见 access-guard.ts）。
 *
 * **不复用 ext-relay 那个 secret**：这一个是要给用户看的（他得抄到手机上），另一个是
 * "驱动你整个浏览器"的钥匙、设计上全程不可见。共用一份等于把后者印在屏幕上。
 *
 * 用户显式配了 `config.api_token` 时以配置为准（自托管/反代场景要能自己定），
 * 没配就用这个自动生成的——**默认必须有一把锁**，而不是默认没有。
 */
export function loadOrCreateApiToken(dir: string): string {
  return loadOrCreateSecret(dir, 'api-token')
}

// tokenEqual 搬去了 shared/browser-relay/token.ts（中继握手专属，且要能被独立进程 import）。
// 保留同名转出，既有消费者不用改。
export { tokenEqual } from '../../shared/browser-relay/token.ts'
