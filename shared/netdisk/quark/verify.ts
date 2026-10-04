import type { VerifyResult } from '../share-validity.ts'
import { makeQuarkCall, quarkShareDetail, quarkShareToken } from './share-api.ts'

export interface QuarkVerifyDeps {
  fetchFn?: typeof fetch
}

/**
 * 夸克分享验活 + 列文件——**匿名、只读**，与 `packages/quark/quark-share.recipe.json` 同一组判决
 * （判例在 `verify.test.ts`，与 recipe 那份测试逐条对照）。Stream 编排层跑的是 recipe；这份 TS 给
 * DSH 网盘插件用——recipe 运行时依赖 isolated-vm，打不进一个要装到别人机器上的插件。
 *
 * 判据是 **HTTP status 不是死因码**：4xx = 上游在讲这条链的事（判决 → not-usable），死因码列不全
 * （41031 封禁 / 41006、41012 取消……）也不会把真死链误报成 unknown。429 是 4xx 里唯一的例外
 * （讲的是我们请求太快），与 5xx / 非 JSON 一样**抛错**——「我们没查成」绝不能伪装成「链接死了」，
 * 抛出去让判决层落到 unknown。
 */
export async function quarkVerify(pwdId: string, opts: { passcode?: string } = {}, deps: QuarkVerifyDeps = {}): Promise<VerifyResult> {
  const call = makeQuarkCall(deps.fetchFn ?? fetch)
  const tok = await quarkShareToken(call, pwdId, opts.passcode ?? '')
  const t = tok.body
  if (typeof t.code !== 'number' || t.code === -1) throw new Error(`quark token: unreadable body (HTTP ${tok.status})`)
  if (t.code !== 0) {
    if (tok.status >= 400 && tok.status < 500 && tok.status !== 429) {
      return { validity: 'not-usable', files: [], reason: String(t.message || `code ${t.code}`) }
    }
    throw new Error(`quark token status ${tok.status} code ${t.code}: ${t.message || '?'}`)
  }
  const stoken = t.data?.stoken
  if (!stoken) throw new Error('quark token: code 0 without stoken')
  const { list } = await quarkShareDetail(call, pwdId, String(stoken))
  const files = list.map((f) => ({ name: String(f.file_name || ''), is_dir: !!f.dir, size: Number(f.size || 0) }))
  return files.length ? { validity: 'alive', files } : { validity: 'not-usable', files: [], reason: '分享里没有文件' }
}
