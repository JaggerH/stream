/**
 * 把认盘的四个动词挂上 DSH 的工具注册表：
 *
 * - `netdisk_verify_share`  一条分享还活不活着、里面有什么（夸克 / 百度；匿名、只读）
 * - `netdisk_save_share`    把一条夸克分享转存进用户自己的盘（**写用户的盘**；要夸克登录态）
 * - `netdisk_play_link`     网盘内一个文件 → 可播放的直链（OpenList 直链；有夸克登录态再带一路转码流）
 * - `netdisk_folder_url`    网盘内一个目录 → 夸克 web 页 URL（要夸克登录态）
 *
 * 「让模型直接翻盘」（列目录 / 取文件信息）**不在这里**：OpenList 自带只读 MCP（`/mcp`，
 * `fs.list` / `fs.get` / `fs.link`），一行 `dsh-mcp-client` 指过去即可（spec §6），别在这儿重写一遍。
 *
 * 三条规矩照抄 `capabilities/desktop/src/tools.ts`：
 * 1. **绝不抛**。这些 `execute` 跑在 DSH 引擎自己的进程里，逃出去的异常带走整个工作台的插件宿主。
 *    每一格都收在 `runVerb` 里：失败落成一个说人话的返回值，且**说清下一步**——「没有浏览器插件」和
 *    「分享死了」是两条完全不同的排查路。
 * 2. **判决逻辑不在这里**：验活 / 转存 / 取流的实现全在 `shared/netdisk/`，Stream 编排层跑的是同一份。
 * 3. 这个文件**只造描述**（`ToolDef[]`），不认识任何宿主：把它们挂到哪张工具树上是
 *    `CapabilityContext.registerTools` 的事（MCP 那张脸 / DSH 那张脸各自翻译）。
 */
import { baiduVerify } from '../../../shared/netdisk/baidu/verify.ts'
import { quarkFolderResolve } from '../../../shared/netdisk/quark/browse.ts'
import { quarkPlayStream, type QuarkStream } from '../../../shared/netdisk/quark/play.ts'
import { quarkSave } from '../../../shared/netdisk/quark/save.ts'
import { quarkVerify } from '../../../shared/netdisk/quark/verify.ts'
import type { VerifyResult } from '../../../shared/netdisk/share-validity.ts'
import type { TextBlock, ToolDef } from '../../../shared/capability/types.ts'

// ── 动词体依赖的那几格 ─────────────────────────────────────────────────────────────────

/** external 档里我们用得到的 OpenList 那两格（`OpenListClient` 满足它）。 */
export interface OpenListLike {
  rawUrl(path: string): Promise<string>
  fileId(path: string): Promise<string>
}

export interface NetdiskSurfaceDeps {
  /** 用户浏览器里某个域的 Cookie 头（浏览器插件的 `streamBrowserCookies` 服务）；取不到 → undefined。 */
  cookieFor(domain: string): Promise<string | undefined>
  /** 那个服务到底在不在——不在时「没登录态」和「没装浏览器插件」要分开说。 */
  hasCookieService(): boolean
  /** external 档的 OpenList 客户端；managed 档未落地 / 配置无效时 → undefined。**每次现取**不存快照。 */
  openlist(): OpenListLike | undefined
  fetchFn: typeof fetch
}

// ── 失败：说人话，且绝不抛 ────────────────────────────────────────────────────────────────

export interface VerbFailure {
  ok: false
  error: string
  hint?: string
}

export const NO_BROWSER_PLUGIN_HINT =
  '这台宿主没有 Stream Desktop（或它还没握上用户的 Chrome）：转存 / 转码流 / 跳转网盘都要用户浏览器里的夸克登录态。让扩展连上来再试；验活不需要它。'

export const NO_OPENLIST_HINT =
  '这一行没有可用的 OpenList：external 档要在 profile 里给 openlistUrl + 永久 openlistToken（Stream 在场时由它递）；managed 档（插件自己拉容器）还没落地。验活 / 转存 / 跳转网盘不需要 OpenList。'

export async function runVerb<T>(verb: string, fn: () => Promise<T>): Promise<T | VerbFailure> {
  try {
    return await fn()
  } catch (err) {
    return { ok: false, error: `${verb} 失败：${err instanceof Error ? err.message : String(err)}` }
  }
}

const RENDER_CAP = 60_000

function renderValue(value: unknown): TextBlock[] {
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    text = String(value)
  }
  if (text.length > RENDER_CAP) text = `${text.slice(0, RENDER_CAP)}\n…（结果太长，已截断到 ${RENDER_CAP} 字符）`
  return [{ type: 'text', text }]
}

const OUTPUT = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: unknown): TextBlock[] => renderValue(value),
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined)
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)

const NETDISKS = ['quark', 'baidu'] as const
type Netdisk = (typeof NETDISKS)[number]

function parseNetdisk(v: unknown): Netdisk {
  const s = str(v)
  if (s === 'quark' || s === 'baidu') return s
  throw new Error(`netdisk 只能是 ${NETDISKS.join(' / ')}（收到 '${s ?? ''}'）`)
}

function requireStr(a: Record<string, unknown>, key: string, what: string): string {
  const s = str(a[key])
  if (!s) throw new Error(`缺 ${key}——${what}`)
  return s
}

/** 一条分享 → 判决。上游 5xx / 限流 / 非 JSON 这些「我们没查成」在这里落成 `unknown` + reason，
 *  而不是抛出去：对模型而言，「没查成」本身就是一个要说出口的结果。 */
async function verifyShare(deps: NetdiskSurfaceDeps, netdisk: Netdisk, pwdId: string, passcode?: string): Promise<VerifyResult> {
  const opts = passcode !== undefined ? { passcode } : {}
  try {
    return netdisk === 'quark' ? await quarkVerify(pwdId, opts, { fetchFn: deps.fetchFn }) : await baiduVerify(pwdId, opts, { fetchFn: deps.fetchFn })
  } catch (err) {
    return { validity: 'unknown', files: [], reason: `没查成：${err instanceof Error ? err.message : String(err)}` }
  }
}

export interface PlayLinkResult {
  /** OpenList 给的直链（网盘原文件；夸克/阿里的直链有时效，几小时）。 */
  rawUrl: string
  /** 夸克自己转好的 H.264+AAC 流（原盘是 AC3/DTS 音轨时浏览器只有画面没有声音，这一路才有声）。
   *  只有拿到夸克登录态、且夸克说转码就绪时才有；没有就没有，不编。 */
  stream?: QuarkStream
}

/**
 * 认盘四个动词的名字。需要按能力包核对工具名的消费者直接 import 这一份，
 * 不再手抄一遍——手抄的第二份漂移时没有任何一处会喊。`netdiskToolOptions` 真产出的名字与它逐字
 * 相等，由 `tools.test.ts` 钉住。
 */
export const NETDISK_TOOL_NAMES = [
  'netdisk_verify_share',
  'netdisk_save_share',
  'netdisk_play_link',
  'netdisk_folder_url',
] as const

/**
 * 造出四个动词的描述。抽成纯函数是为了不接真宿主也能把整套测到。
 */
export function netdiskToolOptions(deps: NetdiskSurfaceDeps): ToolDef[] {
  const make = (name: string, description: string, parameters: ToolDef['parameters'], execute: (a: Record<string, unknown>) => Promise<unknown>): ToolDef => ({
    name,
    description,
    parameters,
    output: OUTPUT,
    execute: (a) => runVerb(name, () => execute(a)),
  })

  return [
    make(
      'netdisk_verify_share',
      '验一条网盘分享还活不活着、里面有哪些文件（匿名、只读，不需要登录态）。validity：alive=活着且列出了文件；not-usable=已失效/封禁/空分享；unknown=没查成（限流/风控/缺提取码），不要把 unknown 当成死链。',
      {
        netdisk: { type: 'string', enum: [...NETDISKS], required: true, description: '哪个网盘：quark（夸克）或 baidu（百度）' },
        pwd_id: { type: 'string', required: true, description: '分享 id：pan.quark.cn/s/<pwd_id> 或 pan.baidu.com/s/<pwd_id>' },
        passcode: { type: 'string', description: '提取码（有就带；百度几乎每条分享都锁着，没有它只能判「链接是否存在」）' },
      },
      async (a) => verifyShare(deps, parseNetdisk(a.netdisk), requireStr(a, 'pwd_id', '分享 id'), str(a.passcode)),
    ),

    make(
      'netdisk_save_share',
      '把一条夸克分享转存进用户自己的夸克网盘（会写用户的盘：在 dest 下建目录并转存整份分享）。需要用户浏览器里的夸克登录态。返回 saved 与 stage：token=分享不可用，auth=没登录态，dest=落点目录建不出来，task=转存任务失败或未在预期时间内完成。只支持夸克。',
      {
        pwd_id: { type: 'string', required: true, description: '夸克分享 id（pan.quark.cn/s/<pwd_id>）' },
        dest: { type: 'string', required: true, description: '落点根目录名（相对网盘根，如 "From Stream"）；不存在就建' },
        subdir: { type: 'string', description: '落点下再建一层（如作品名）。是一个目录名，不是路径' },
        passcode: { type: 'string', description: '分享提取码（如有）' },
      },
      async (a) => {
        const pwdId = requireStr(a, 'pwd_id', '夸克分享 id')
        const dest = requireStr(a, 'dest', '落点根目录名')
        if (!deps.hasCookieService()) {
          return { ok: false, error: 'netdisk_save_share 需要夸克登录态，而这台宿主没有可借登录态的浏览器插件', hint: NO_BROWSER_PLUGIN_HINT } satisfies VerbFailure
        }
        const subdir = str(a.subdir)
        const passcode = str(a.passcode)
        return quarkSave(
          pwdId,
          { dest, ...(subdir !== undefined ? { subdir } : {}), ...(passcode !== undefined ? { passcode } : {}) },
          { cookieFor: (d) => deps.cookieFor(d), fetchFn: deps.fetchFn },
        )
      },
    ),

    make(
      'netdisk_play_link',
      '网盘内一个文件（OpenList 挂载路径，如 /quark/From Stream/xxx/E01.mkv）→ 可播放的直链。rawUrl 是网盘原文件的直链（有时效）；stream 是夸克自己转好的 H.264+AAC 流（原盘音轨浏览器放不出声时用它），只在有夸克登录态且转码就绪时出现。',
      {
        path: { type: 'string', required: true, description: 'OpenList 里的文件路径（以挂载点开头，如 /quark/...）' },
        transcode: { type: 'boolean', description: '要不要顺带取夸克转码流（默认 true；只要 rawUrl 时传 false 省一次请求）' },
      },
      async (a) => {
        const path = requireStr(a, 'path', 'OpenList 文件路径')
        const openlist = deps.openlist()
        if (!openlist) return { ok: false, error: 'netdisk_play_link 需要 OpenList，而这一行没有', hint: NO_OPENLIST_HINT } satisfies VerbFailure
        const rawUrl = await openlist.rawUrl(path)
        const out: PlayLinkResult = { rawUrl }
        if (bool(a.transcode) !== false && deps.hasCookieService()) {
          const cookie = await deps.cookieFor('quark.cn')
          if (cookie) {
            try {
              const fid = await openlist.fileId(path)
              const stream = await quarkPlayStream(fid, { cookieFor: async () => cookie, fetchFn: deps.fetchFn })
              if (stream) out.stream = stream
            } catch {
              // 转码流是锦上添花：拿不到就只回直链，别把一次成功的取链报成失败。
            }
          }
        }
        return out
      },
    ),

    make(
      'netdisk_folder_url',
      '网盘内一个目录（相对网盘根的路径，如 "From Stream/流浪地球"）→ 用户能直接点开的网盘 web 页 URL。只支持夸克（按 fid 定位文件夹），需要夸克登录态。找不到（目录被删/改名）→ found:false。',
      {
        netdisk: { type: 'string', enum: ['quark'], required: true, description: '只支持 quark' },
        path: { type: 'string', required: true, description: '相对夸克盘根的目录路径，用 / 分层' },
      },
      async (a) => {
        const netdisk = parseNetdisk(a.netdisk)
        if (netdisk !== 'quark') throw new Error('netdisk_folder_url 只支持 quark')
        const path = requireStr(a, 'path', '目录路径')
        if (!deps.hasCookieService()) {
          return { ok: false, error: 'netdisk_folder_url 需要夸克登录态，而这台宿主没有可借登录态的浏览器插件', hint: NO_BROWSER_PLUGIN_HINT } satisfies VerbFailure
        }
        const hit = await quarkFolderResolve(path.split('/'), { cookieFor: (d) => deps.cookieFor(d), fetchFn: deps.fetchFn })
        return hit ? { found: true, url: hit.url, fid: hit.fid } : { found: false, message: `夸克盘里没有 ${path}（目录被删/改名，或登录态失效）` }
      },
    ),
  ]
}
