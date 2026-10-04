import { QUARK_DRIVE_H, QUARK_DRIVE_PC, QUARK_Q as Q, makeQuarkCall, quarkShareDetail, quarkShareToken } from './share-api.ts'

const DRIVE_H = QUARK_DRIVE_H
const DRIVE_PC = QUARK_DRIVE_PC
/** the transfer is an async job on quark's side; these bound the wait, not the work */
const TASK_POLLS = 15
const TASK_INTERVAL_MS = 1000
/** quark's "a folder by that name is already here" — a race lost, not an error */
const CODE_NAME_CONFLICT = 23008

export interface QuarkSaveResult {
  saved: boolean
  /** where it stopped: token | detail | dest | save | task; 'done' on success */
  stage: string
  message: string
  dest?: string
  to_pdir_fid?: string
  file_count?: number
  files?: string
  task_id?: string
}

export interface QuarkSaveDeps {
  /** the user's quark cookie, injected by the host (the host is the only scheduler — nothing
   *  ever calls back into it for credentials) */
  cookieFor: (domain: string) => Promise<string | undefined>
  fetchFn?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

/**
 * Transfer a quark share into the user's own drive, under `dest`.
 *
 * Why this is code and not a recipe: it WRITES the user's drive. 热插数据只能读——写操作
 * 永远是审过的、随版本发布的代码（capability-normalization spec §2，Gap C 拍板
 * 2026-07-17）。引擎表达力已不是边界（jar/params/poll 都可以长），信任模型才是。
 * 姊妹源 quark-share（验活，只读）是 recipe。住在 shared/netdisk/quark/：
 * Stream 编排层与 DSH 网盘插件同吃这一份（spec 2026-09-02-netdisk-capability-plugin）。
 *
 * No browser: quark's share API is cookie-only, with no signature anywhere — the same contract
 * AList drives. So this runs from the host in ~2s instead of ~4s inside a 200-300MB tab that
 * serialises behind every other task on the quark facility.
 *
 * Every failure returns a `stage` rather than throwing: "the share is dead" and "the folder
 * could not be made" are results the caller must be able to tell apart and say out loud.
 */
export async function quarkSave(
  pwdId: string,
  opts: { dest: string; subdir?: string; subpath?: string[]; passcode?: string; files?: Array<{ fid: string; share_fid_token: string; pdir_fid?: string }> },
  deps: QuarkSaveDeps,
): Promise<QuarkSaveResult> {
  const send = deps.fetchFn ?? fetch
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const cookie = await deps.cookieFor('quark.cn')
  if (!cookie) return { saved: false, stage: 'auth', message: '没有夸克登录态（quark.cn 不在同步域里，或还没取回过）' }

  // 判决在 body 里、status 一并交回（4xx 也照样读 body）——见 share-api.ts 的 makeQuarkCall。
  const raw = makeQuarkCall(send, cookie)
  const call = async (url: string, init?: RequestInit): Promise<Record<string, any>> => (await raw(url, init)).body

  // 1. share token — the first thing that knows whether this share is alive at all
  const tok = (await quarkShareToken(raw, pwdId, opts.passcode ?? '')).body
  const stoken = tok.data?.stoken
  if (tok.code !== 0 || !stoken) return { saved: false, stage: 'token', message: String(tok.message || '分享不可用') }

  // 2. what's inside — 调用方指定了文件就只转那些（追更只补缺的那几集，整份转存 = 整季重传）
  let list: Array<{ fid: string; share_fid_token: string; pdir_fid?: string; file_name?: string }>
  if (opts.files?.length) {
    // 调用方给的只当「要哪些 fid、各在哪个父目录」；**token 必须用这一次的 stoken 重新取**。
    // `share_fid_token` 绑在取它的那次 sharepage/token 会话上：追更的验活列表是匿名会话拿的，
    // 拿到转存这边（带登录态、新 stoken）一律「转存文件token校验异常」（活体 2026-09-03，
    // 探针证实同一文件用本会话的 detail 重取 token 后当场成功）。
    const wanted = new Map(opts.files.map((f) => [f.fid, f]))
    const byDir = new Map<string, string[]>()
    for (const f of opts.files) byDir.set(f.pdir_fid ?? '0', [...(byDir.get(f.pdir_fid ?? '0') ?? []), f.fid])
    list = []
    for (const [pdir] of byDir) {
      const fresh = await quarkShareDetail(raw, pwdId, String(stoken), pdir, 200)
      for (const e of fresh.list) if (wanted.has(e.fid)) list.push({ fid: e.fid, share_fid_token: e.share_fid_token, pdir_fid: pdir, file_name: e.file_name })
    }
    const missing = opts.files.filter((f) => !list.some((l) => l.fid === f.fid)).map((f) => f.fid)
    if (missing.length) return { saved: false, stage: 'detail', message: `分享里已经找不到这些文件（可能被分享者删了或挪了）：${missing.join(', ')}` }
  } else {
    const detail = await quarkShareDetail(raw, pwdId, String(stoken))
    list = detail.list
    if (!list.length) return { saved: false, stage: 'detail', message: String(detail.body.message || '分享里没有文件') }
  }

  // 3. destination folder, ensured
  // `subdir` 仍是**一个目录名**（片名可以带 '/'，由 ensureDir 中和，别劈）；`subpath` 才是它下面的层级
  // ——追更把分享里的子文件夹原样落到作品目录下（`tv-261471/第三季（4K）/`），认集靠的季文件夹信息才不会丢。
  const destFid = await ensureDir([opts.dest, opts.subdir, ...(opts.subpath ?? [])], call)
  if (!destFid.fid) return { saved: false, stage: 'dest', message: destFid.message }

  // 4. hand it to quark — **按分享里的父目录分组，一组一次**。夸克按 (pdir_fid, fid, token) 校验，
  //    子文件夹里的文件拿根目录（'0'）提交会回「转存文件token校验异常」（活体 2026-09-03）。
  //    顶层 detail 列出来的条目没有 pdir_fid，就是根。
  const groups = new Map<string, typeof list>()
  for (const f of list) {
    const k = f.pdir_fid ?? '0'
    groups.set(k, [...(groups.get(k) ?? []), f])
  }
  const taskIds: string[] = []
  for (const [pdirFid, group] of groups) {
    const sv = await call(`${DRIVE_H}/share/sharepage/save${Q}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fid_list: group.map((f) => f.fid),
        fid_token_list: group.map((f) => f.share_fid_token),
        to_pdir_fid: destFid.fid,
        pwd_id: pwdId,
        stoken,
        pdir_fid: pdirFid,
        scene: 'link',
      }),
    })
    if (sv.code !== 0) return { saved: false, stage: 'save', message: String(sv.message || `code ${sv.code}`) }
    if (sv.data?.task_id) taskIds.push(String(sv.data.task_id))
  }

  const files = list.map((f) => f.file_name ?? f.fid).join(' | ')
  // dest = 实际建出的网盘内路径（sanitize 后），调用方据此拼绑定的 AList 路径。
  // `task_id` 用展开而不是直接写 `task_id: taskIds[0]`：`task_id?: string` 配上能力包那份更严的
  // tsconfig（`exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`）时，「这一格存在但值是
  // undefined」和「这一格不存在」是两回事，前者不合法。没有 task 就不写这一格。
  const base = { dest: destFid.path ?? '', to_pdir_fid: destFid.fid, file_count: list.length, files, ...(taskIds[0] ? { task_id: taskIds[0] } : {}) }

  // 5. the transfer is a job, not a response: report done only once quark says so — 每组一个 task，
  //    全部到 2 才算 done；任一到 3 就是失败。预算是总预算，不按组翻倍。
  if (!taskIds.length) return { saved: true, stage: 'done', message: '已提交转存', ...base }
  const pending = new Set(taskIds)
  let lastTitle = ''
  let landed = 0
  for (let i = 0; i < TASK_POLLS && pending.size; i++) {
    for (const taskId of [...pending]) {
      const t = await call(`${DRIVE_PC}/task${Q}&task_id=${encodeURIComponent(taskId)}&retry_index=${i}`)
      const status = t.data?.status
      if (status === 2) {
        pending.delete(taskId)
        lastTitle = String(t.data?.task_title || '')
        // 夸克在 task 里报实际转进去几个（save_as_sum_num）。少于提交数就是部分成功——写进 message，
        // 别让「done」把它盖住（活体：一次 9 个只到 1 个，而 status 照样是 2）。
        const n = Number(t.data?.save_as?.save_as_sum_num)
        if (Number.isFinite(n)) landed += n
      }
      else if (status === 3) return { saved: false, stage: 'task', message: String(t.data?.task_title || '转存任务失败'), ...base }
    }
    if (pending.size) await sleep(TASK_INTERVAL_MS)
  }
  if (!pending.size) {
    // 夸克没报数（老响应）就按提交数算；报了就信它——少了要在 message 里说出来。
    const actual = landed > 0 ? landed : list.length
    const partial = actual < list.length ? `（只转进去 ${actual}/${list.length} 个）` : ''
    return { saved: true, stage: 'done', message: `${lastTitle || '转存完成'}${partial}`, ...base, file_count: actual }
  }
  // Still running when the budget ran out. It very likely lands — but this function must not
  // claim an outcome it did not observe.
  return { saved: false, stage: 'task', message: '转存任务未在预期时间内完成（可能仍在进行）', ...base }
}

/**
 * The destination folder's fid, creating it if absent.
 *
 * Two quark behaviours drive this order, both measured:
 *  - `file/sort` does NOT immediately list a just-created folder, so the fid `file` returns is
 *    the only reliable handle — never re-list to find what was just made.
 *  - a same-name `file` is refused (23008), so quark itself prevents duplicates; losing the
 *    race just means someone else made it, and a re-lookup then finds it.
 */
async function ensureDir(
  segs: Array<string | undefined>,
  call: (url: string, init?: RequestInit) => Promise<Record<string, any>>,
): Promise<{ fid?: string; path?: string; message: string }> {
  // 每段都是**一个目录名**，不是路径：段内的 '/' 属于名字（片名可以带 '/'），必须中和掉，
  // 否则一部片子会散成两层目录。段永远不从字符串切出来——参数管道声明的是 scalar，
  // 让数组穿过它就会被 String() 拍成 'a,b'（活体实测：真在盘上建出了 `From Stream,流浪地球`）。
  const segments = segs
    .filter((x): x is string => !!x)
    .map((x) => sanitizeSegment(x).trim())
    .filter(Boolean)
  if (!segments.length) return { message: '落点目录为空' }

  let pdir = '0'
  for (const name of segments) {
    const step = await ensureOne(name, pdir, call)
    if (!step.fid) return step
    pdir = step.fid
  }
  // path = 实际建出的网盘内路径（已 sanitize）。调用方用它拼绑定的 AList 路径——绝不能用原始
  // segments join，否则含 '/' 的片名会让绑定指向一个根本不存在的两层路径。
  return { fid: pdir, path: segments.join('/'), message: '' }
}

/** 目录名里的 '/' 会被切成层级——片名带斜杠时必须先中和掉，否则一部片子会散成两层目录。 */
function sanitizeSegment(name: string): string {
  return name.replace(/\//g, '_')
}

/** 某个父目录下的一层：查 → 有就用 → 没有就建 → 撞同名再查一次。 */
async function ensureOne(
  name: string,
  pdirFid: string,
  call: (url: string, init?: RequestInit) => Promise<Record<string, any>>,
): Promise<{ fid?: string; message: string }> {
  const lookup = async (): Promise<string | undefined> => {
    const dir = await call(`${DRIVE_PC}/file/sort${Q}&pdir_fid=${encodeURIComponent(pdirFid)}&_page=1&_size=100`)
    const hit = ((dir.data?.list ?? []) as Array<{ file_name: string; dir: boolean; fid: string }>)
      .find((f) => f.file_name === name && f.dir)
    return hit?.fid
  }

  const existing = await lookup()
  if (existing) return { fid: existing, message: '' }

  const mk = await call(`${DRIVE_PC}/file${Q}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pdir_fid: pdirFid, file_name: name, dir_path: '', dir_init_lock: false }),
  })
  if (mk.code === 0 && mk.data?.fid) return { fid: mk.data.fid, message: '' }
  if (mk.code === CODE_NAME_CONFLICT) {
    const raced = await lookup()
    if (raced) return { fid: raced, message: '' }
  }
  return { message: `建不出落点目录 ${name}：${mk.message || `code ${mk.code}`}` }
}
