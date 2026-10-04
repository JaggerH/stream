import type { VerifyResult } from '../share-validity.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
/** 百度的 errno，全部活体量过——没有一个是猜的。 */
const ERR_NO_SUCH_LINK = 140 // shorturlinfo：「啊哦，链接出错了」——分享不存在
const ERR_PASSCODE = -9 // 「提取码验证失败」——链接**在**，只是看不进去

export interface BaiduVerifyDeps {
  fetchFn?: typeof fetch
  /** 毫秒时间戳（`share/verify` 的 `t`）。注入只为测试。 */
  now?: () => number
}

type Json = Record<string, any>

/**
 * 百度分享验活——**匿名、只读、无签名**，与 `packages/baidu/baidu-share.recipe.json` 同一组判决
 * （判例在 `verify.test.ts`，与 recipe 那份测试逐条对照）。Stream 编排层跑 recipe；这份 TS 给 DSH
 * 网盘插件用（recipe 运行时依赖 isolated-vm，打不进插件）。
 *
 * 链路（每个怪癖都是活体量出来的）：
 *   1. `shorturlinfo` 匿名                → errno 140 = 链接不存在 → 死
 *   2. 落一次分享页（会话 cookie 从这里开始）
 *   3. `share/verify?surl=<id 去掉前导 1>` → 提取码换 randsk，百度顺手 Set-Cookie 授权
 *   4. `shorturlinfo` 带整罐 cookie        → errno 0 + uk/shareid
 *   5. `share/list?...&root=1`             → 文件名
 *
 * 三个坑：`surl` 是 /s/1xxxx 里**去掉前导 '1'** 的那段；BDCLND 必须是百度 **Set-Cookie 下来的那份**
 * （不是 randsk url-decode，那答 -9），且整罐 cookie 都要随行；`share/list` 要 `root=1`（`dir=/` 答 errno 2）。
 *
 * `unknown` 是承重的：提取码被拒/没给，意味着链接在、我们看不进去。报成死链等于把一条活链从用户
 * 结果里删掉。风控 HTML 页同理——那是「我们没查成」，不是判决。
 */
export async function baiduVerify(pwdId: string, opts: { passcode?: string } = {}, deps: BaiduVerifyDeps = {}): Promise<VerifyResult> {
  const send = deps.fetchFn ?? fetch
  const now = deps.now ?? (() => Date.now())

  const jar = new Map<string, string>()
  const call = async (url: string, init: RequestInit = {}): Promise<Json | null> => {
    const res = await send(url, {
      ...init,
      headers: {
        'user-agent': UA,
        referer: `https://pan.baidu.com/s/${pwdId}`,
        ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(init.headers ?? {}),
      },
      redirect: 'manual',
    })
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair = ''] = sc.split(';')
      const eq = pair.indexOf('=')
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
    const text = await res.text()
    try {
      return JSON.parse(text) as Json
    } catch {
      return null // HTML 页（风控 / 验证）——不是判决
    }
  }
  const infoUrl = `https://pan.baidu.com/api/shorturlinfo?shorturl=${encodeURIComponent(pwdId)}&root=1&web=1&clienttype=0`

  // 1. 链接到底在不在？没有提取码时这是唯一能回答的问题。
  const first = await call(infoUrl)
  if (!first) return { validity: 'unknown', files: [], reason: '百度没有返回 JSON（可能是风控页）' }
  if (first.errno === ERR_NO_SUCH_LINK) return { validity: 'not-usable', files: [], reason: String(first.show_msg || '链接不存在') }
  if (first.errno !== 0 && first.errno !== ERR_PASSCODE) return { validity: 'unknown', files: [], reason: `shorturlinfo errno ${first.errno}` }

  // 链接在。没有提取码就看不进去——也绝不能装作看进去了。
  if (!opts.passcode) {
    if (first.errno === 0) return listFiles(call, first)
    return { validity: 'unknown', files: [], reason: '需要提取码，帖子里没给' }
  }

  // 2. 像浏览器一样落一次分享页（会话 cookie 从这里开始）
  await call(`https://pan.baidu.com/s/${encodeURIComponent(pwdId)}`).catch(() => null)

  // 3. 提取码 → randsk（+ 授权它的 cookie，吸进罐里）
  const surl = pwdId.startsWith('1') ? pwdId.slice(1) : pwdId
  const v = await call(
    `https://pan.baidu.com/share/verify?surl=${encodeURIComponent(surl)}&t=${now()}&channel=chunlei&web=1&app_id=250528&clienttype=0`,
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `pwd=${encodeURIComponent(opts.passcode)}&vcode=&vcode_str=` },
  )
  if (!v) return { validity: 'unknown', files: [], reason: '提取码校验没有返回 JSON' }
  if (v.errno !== 0) {
    // 这里的 -9 是**提取码被拒**，不是死链——第 1 步没说 140，链接可证明地在。
    return { validity: 'unknown', files: [], reason: v.errno === ERR_PASSCODE ? '提取码不对' : `提取码校验 errno ${v.errno}` }
  }

  // 4. 现在分享能解析了——读 id，再读文件
  const info = await call(infoUrl)
  if (!info || info.errno !== 0) return { validity: 'unknown', files: [], reason: `解锁后 shorturlinfo errno ${info?.errno}` }
  return listFiles(call, info)
}

async function listFiles(call: (url: string) => Promise<Json | null>, info: Json): Promise<VerifyResult> {
  const list = await call(
    `https://pan.baidu.com/share/list?uk=${encodeURIComponent(String(info.uk ?? ''))}&shareid=${encodeURIComponent(String(info.shareid ?? ''))}` +
      `&order=other&desc=1&showempty=0&web=1&page=1&num=100&root=1&clienttype=0`,
  )
  if (!list) return { validity: 'unknown', files: [], reason: 'share/list 没有返回 JSON' }
  if (list.errno !== 0) return { validity: 'unknown', files: [], reason: `share/list errno ${list.errno}` }
  const files = ((list.list ?? []) as Json[]).map((f) => ({
    name: String(f.server_filename ?? ''),
    is_dir: f.isdir === 1 || f.isdir === '1',
    size: Number(f.size ?? 0),
  }))
  return files.length ? { validity: 'alive', files } : { validity: 'not-usable', files: [], reason: '分享里没有文件' }
}
