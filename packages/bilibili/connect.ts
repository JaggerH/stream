import type { ConnectFn } from '../../src/packages/activate.ts'
import { ValidationError } from '../../shared/package-sdk/errors.ts'
import type { BilibiliClient } from './client.ts'

const DOMAIN = 'bilibili.com'

/**
 * 一键订阅「我的关注」：uid 从用户自己的 cookie 里读（`DedeUserID`），所以这件事**零输入**。
 * 订阅的是一条合并流——所有关注的 UP 主动态汇成一条，而不是每个人一条流。
 */
export function makeConnect(client: Pick<BilibiliClient, 'myUid' | 'user'>): Record<string, ConnectFn> {
  return {
    [DOMAIN]: async () => {
      const uid = await client.myUid()
      if (!uid) throw new ValidationError('no bilibili login cookie (DedeUserID) found')
      let name = ''
      try {
        name = (await client.user(uid)).name
      } catch {
        /* 名字只是好看——card 接口打嗝也照样把流建起来 */
      }
      return {
        stream: {
          id: `bilibili-following-${uid}`,
          description: name ? `我的 B 站关注 · ${name}` : '我的 B 站关注',
          sources: [{ source_id: 'rsshub:bilibili/followings/dynamic/:uid/:routeParams?', params: { uid } }],
          cadence_seconds: 172800, // 2d 默认采集周期（与其它新建路径一致）
          vault_subdir: `bilibili-following-${uid}`,
        },
        extra: { uid, name },
      }
    },
  }
}
