import { makeQuarkCall, quarkShareToken, quarkShareTree } from '../../../shared/netdisk/quark/share-api.ts'
import { quarkSave } from '../../../shared/netdisk/quark/save.ts'
import { NETDISK_SAVE_DEST } from '../../../shared/netdisk/save-dest.ts'
import type { ShareClient } from './types.ts'

/**
 * 夸克的 `ShareClient`：验活 + 递归列树（匿名可读）+ 按文件转存（要登录态）。
 *
 * 判决口径与 `quarkVerify` 同一套：4xx（429 除外）+ code≠0 才敢说「不行」，其余一律 `unknown`
 * ——「没验到」和「验过了、不行」必须分得开，前者不该让追更把这条分享判死。
 *
 * 凭证只经注入的 `cookieFor` 拿（宿主派发，包不索取）；这里不认识任何 cookie 存储。
 */
export function quarkShareClient(deps: {
  cookieFor: (domain: string) => Promise<string | undefined>
  fetchFn?: typeof fetch
}): ShareClient {
  const send = deps.fetchFn ?? fetch
  return {
    supports: (n) => n === 'quark',
    async list(_n, pwdId, passcode) {
      const call = makeQuarkCall(send)
      const tok = await quarkShareToken(call, pwdId, passcode ?? '')
      const t = tok.body
      if (typeof t.code !== 'number' || t.code === -1) return { validity: 'unknown', files: [], reason: `unreadable (HTTP ${tok.status})` }
      if (t.code !== 0) {
        if (tok.status >= 400 && tok.status < 500 && tok.status !== 429) return { validity: 'not-usable', files: [], reason: String(t.message || `code ${t.code}`) }
        return { validity: 'unknown', files: [], reason: `status ${tok.status} code ${t.code}` }
      }
      const stoken = t.data?.stoken
      if (!stoken) return { validity: 'unknown', files: [], reason: 'code 0 without stoken' }
      const files = (await quarkShareTree(call, pwdId, String(stoken))).map((f) => ({
        fid: f.fid, token: f.share_fid_token, pdirFid: f.pdir_fid, name: f.name, size: f.size, path: f.path,
      }))
      return files.length ? { validity: 'alive', files } : { validity: 'not-usable', files: [], reason: '分享里没有文件' }
    },
    async save(_n, pwdId, o) {
      // `FollowService` 递来的 subdir 是绑定路径的末两段（`From Stream/tv-261471`），而 quarkSave
      // 的 dest 已经是 `From Stream`——不剥掉前缀就会转进 `From Stream/From Stream/tv-261471`，
      // 而且那个目录**建得出来**，所以没有任何一处会喊，只是绑定永远看不到新到的文件。
      const prefix = `${NETDISK_SAVE_DEST}/`
      // 剥掉前缀之后剩下的可以带层级（`tv-261471/第三季（4K）`）：第一段是作品目录名，其余是分享里的
      // 子文件夹，逐层建。作品目录名本身不带 '/'（opaqueWorkDirName），所以这里按 '/' 劈是安全的。
      const [subdir, ...subpath] = (o.subdir.startsWith(prefix) ? o.subdir.slice(prefix.length) : o.subdir).split('/')
      const r = await quarkSave(
        pwdId,
        { dest: NETDISK_SAVE_DEST, subdir, subpath, passcode: o.passcode, files: o.files.map((f) => ({ fid: f.fid, share_fid_token: f.token, pdir_fid: f.pdirFid ?? '0' })) },
        { cookieFor: deps.cookieFor, fetchFn: send },
      )
      return { saved: r.saved, stage: r.stage, message: r.message }
    },
  }
}
