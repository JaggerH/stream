import type { ConnectFn } from '../../src/packages/activate.ts'

const DOMAIN = 'douyin.com'

/**
 * 一键订阅「我的抖音关注」：source 侧是本包的 `douyin-follow` recipe（登录态浏览器打开关注页，
 * 在页内调站点自己的签名客户端翻 `follow/feed`），不需要任何输入——建流本身零输入，登录态在
 * 采集时才用得到。
 *
 * **不带 params**：recipe 的 `params_schema` 是空的，多递一个 `mode` 只会在校验那一关被拒
 * （旧的容器成员吃过这个参数，源迁走之后它就是一个没人认的字）。
 */
export function makeConnect(): Record<string, ConnectFn> {
  return {
    [DOMAIN]: async () => ({
      stream: {
        id: 'douyin-follow',
        description: '我的抖音关注',
        sources: [{ source_id: 'douyin-follow', params: {} }],
        cadence_seconds: 172800, // 2d 默认采集周期（与其它新建路径一致）
        vault_subdir: 'douyin-follow',
      },
    }),
  }
}
