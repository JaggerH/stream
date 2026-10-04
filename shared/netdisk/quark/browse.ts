const Q = '?pr=ucpro&fr=pc&uc_param_str='
const DRIVE_PC = 'https://drive-pc.quark.cn/1/clouddrive'
/** 裸客户端会被夸克打发去落地页；这两个头让它当作 web app 应答（与 quark-save 同）。 */
const BASE_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  referer: 'https://pan.quark.cn/',
}

/** 夸克文件夹的 web URL。夸克用 fid 定位文件夹（不是路径），点了直接落到用户自己盘里那一层。 */
export function quarkFolderUrl(fid: string): string {
  return `https://pan.quark.cn/list#/list/all/${fid}`
}

export interface QuarkBrowseDeps {
  cookieFor: (domain: string) => Promise<string | undefined | null>
  fetchFn?: typeof fetch
  /** 观测：某段找不到时，把夸克这一层的 code/message/子项数报出来——区分「登录态失效」和「目录真没有」。 */
  log?: (msg: string) => void
}

/**
 * **只读**：把网盘内路径段（如 `['From Stream','tv-278624']`）解析成夸克
 * 文件夹 fid —— 从根 `'0'` 逐层 `file/sort` 找同名子目录。任一层找不到（目录被删/改名/还没建好）
 * → null。**不建目录**（那是 quark-save 的写操作，走审过的代码）；这里纯读，只为「跳转夸克」拼 URL。
 *
 * 前提：调用方给的段是**相对夸克盘根**的（AList `/quark` 挂载 rooted 在夸克根时成立）。挂载 rooted 在
 * 子目录的情况本函数够不着 → 返回 null，调用方回落 AList 链接。
 */
export async function quarkResolveDirFid(segments: string[], deps: QuarkBrowseDeps): Promise<string | null> {
  const send = deps.fetchFn ?? fetch
  const cookie = await deps.cookieFor('quark.cn')
  if (!cookie) { deps.log?.('[quark-browse] 无 quark.cn 登录态'); return null }
  const call = async (url: string): Promise<Record<string, unknown>> => {
    const res = await send(url, { headers: { ...BASE_HEADERS, cookie } })
    return (await res.json().catch(() => ({ code: -1 }))) as Record<string, unknown>
  }

  // 目录名里的 '/' 在 quark-save 建目录时被中和成 '_'（片名可带 '/'）——匹配时同样中和，才对得上盘上真名。
  const names = segments.map((s) => s.replace(/\//g, '_').trim()).filter(Boolean)
  if (!names.length) return null

  let pdir = '0'
  for (const name of names) {
    const dir = await call(`${DRIVE_PC}/file/sort${Q}&pdir_fid=${encodeURIComponent(pdir)}&_page=1&_size=200`)
    const list = ((dir.data as { list?: Array<{ file_name: string; dir: boolean; fid: string }> })?.list) ?? []
    const hit = list.find((f) => f.file_name === name && f.dir)
    if (!hit?.fid) {
      // code!==0 = 夸克拒了（登录态失效/封禁）；code===0 但没这个子目录 = 目录真被删/改名。
      deps.log?.(`[quark-browse] 段「${name}」未命中：code=${JSON.stringify(dir.code)} msg=${JSON.stringify(dir.message)} 该层子项 ${list.length} 个`)
      return null
    }
    pdir = hit.fid
  }
  return pdir === '0' ? null : pdir
}

/**
 * 网盘内路径段 → 夸克文件夹 web URL（+ fid，供缓存）。quark-folder builtin source 的实现:
 * netdisk.folder 调用点 dispatch 到 netdisk-folder-quark Provider → 这里。解析不到 → null。
 */
export async function quarkFolderResolve(segments: string[], deps: QuarkBrowseDeps): Promise<{ url: string; fid: string } | null> {
  const fid = await quarkResolveDirFid(segments, deps)
  return fid ? { url: quarkFolderUrl(fid), fid } : null
}
