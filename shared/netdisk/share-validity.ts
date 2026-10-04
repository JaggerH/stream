/**
 * 「一条网盘分享还活着吗」的判决形状——Stream 编排层（`src/netdisk/share-capability.ts`）与 DSH
 * 网盘插件共用同一份词汇，两边对同一条分享说的是同一句话。
 *
 * `not-usable` 合并了"已失效/已封禁/空分享"——都不可用。`needs-login` 是登录态掉了，不是链接死了。
 *
 * `unknown` = **我们没查成**（上游 5xx / 限流 / 网络故障 / body 不是 JSON），对这条链一无所知。
 * 它必须和 `not-usable` 分开：判决只在上游明确告知时才下得了，其余一律是我们自己的失败。把
 * "没查成"说成"已失效"是撒谎——而死链默认隐藏，这个谎会让一条活链静悄悄消失。
 */
export type ShareValidity = 'alive' | 'not-usable' | 'needs-login' | 'unknown'

export interface ShareFile {
  name: string
  is_dir: boolean
  size: number
}

export interface VerifyResult {
  validity: ShareValidity
  /** 分享里装的东西——文件名是"这是不是我要的那个资源"的最强信号，比 snippet 准得多 */
  files: ShareFile[]
  /** 为什么，能引上游原话就引原话——给轨迹 / 给人看 */
  reason?: string
}
