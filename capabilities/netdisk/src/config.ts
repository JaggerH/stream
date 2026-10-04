/**
 * 这一行在 profile 里收的 config，以及「走哪一档」的判决。
 *
 * 两档**由配置决定，不由运行时猜**（spec §5.2）——「这台机器的 OpenList 归谁管」的运行时仲裁是
 * 浏览器插件走过的最贵的路，这里不重走：
 * - 给了 `openlistUrl`（+ 永久 token）→ **external 档**：只做读 / 转存 / 播放，不碰 storage admin
 *   （挂载自愈归给这个 URL 的那一方——Stream 在场时就是 Stream，两个 reconciler 抢一个 OpenList 会打架）。
 * - 没给 → **managed 档**：插件自己拉容器、接管 admin、跑挂载自愈（spec §8 阶段 5，尚未落地）。
 */
export interface NetdiskHostConfig {
  /**
   * external 档：一个本进程能直接打到的 OpenList 基址。Stream 递的是它自己那扇门下的网关路径
   * （`http://127.0.0.1:8900/_p/alist`）——**不是** standby 给容器发的随机 loopback 口：那个口随容器
   * 生灭（闲置回收后重起就换号），写进 profile 的那一份会静默失效；网关路径稳定且会替我们唤醒容器。
   */
  openlistUrl?: string
  /**
   * external 档：**永久 token**（OpenList `x_setting_items.token`，设置页或接管序列产生），
   * **不能是 `auth/login` 换来的 48h JWT**——插件侧没有 Stream 的「401 自动重登」通道，JWT 过期就是
   * 静默断连（spec §5.3）。`resolveTier` 会拒掉 JWT 形状的值。
   */
  openlistToken?: string
  /** managed 档的细节（镜像 / 空闲回收 / 挂哪些网盘）；只在没给 `openlistUrl` 时有意义。 */
  managed?: import('./managed.ts').ManagedConfig
  /** 插件自己的 data 目录（managed 档的 admin 密码 + 永久 token 落这里）；缺省 `~/.stream-netdisk-plugin`。 */
  dataDir?: string
}

export type NetdiskTier =
  | { kind: 'external'; url: string; token: string }
  | { kind: 'managed' }
  | { kind: 'invalid'; reason: string }

/** 判据与 Stream 侧同一份（`shared/netdisk/token-shape.ts`）：那边据它决定要不要先换永久 token 再递。 */
import { isJwtLike } from '../../../shared/netdisk/token-shape.ts'
export { isJwtLike }

export function resolveTier(config: NetdiskHostConfig): NetdiskTier {
  const url = config.openlistUrl?.trim()
  const token = config.openlistToken?.trim()
  if (!url) return { kind: 'managed' }
  if (!token) {
    return { kind: 'invalid', reason: `给了 openlistUrl（${url}）但没给 openlistToken——external 档不能匿名，OpenList 的 /api 要 token。` }
  }
  if (isJwtLike(token)) {
    return {
      kind: 'invalid',
      reason:
        'openlistToken 是一枚 48h JWT（auth/login 换来的那种），不是永久 token：插件没有 401 自动重登通道，JWT 过期就是静默断连。' +
        '要的是 OpenList 设置页里的永久 token（x_setting_items.token；Stream 在场时由它经 /api/admin/setting/get?key=token 取出递过来）。',
    }
  }
  return { kind: 'external', url: url.replace(/\/+$/, ''), token }
}
