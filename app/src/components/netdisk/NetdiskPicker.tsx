import { useRef, useState } from 'react'
import { FilePickerDialog, type FileEntry, type FileBrowserLabels } from '../acrylic/file-picker.tsx'
import { api, type Connection } from '../../lib/api.ts'

/**
 * 把 acrylic 的 FilePickerDialog 接到 AList 上——13 个调用点只面对这一层。
 *
 * 组件本身对后端一无所知（数据全走回调），所以「AList 怎么列目录、怎么建目录、
 * 中文文案是什么」这些答案只在这里出现一次。调用点改动降到只剩开关和结果。
 */

const ZH: Partial<FileBrowserLabels> = {
  root: '根目录',
  loading: '加载中…',
  empty: '空目录',
  noMatches: '没有匹配项',
  selectionEmpty: '未选择',
  searchLocal: '搜索当前目录…',
  // ZH 这份基底是**目录选择框**口味的（title/confirm 也是「选择网盘目录」「选定此目录」），
  // 文件那个弹窗在自己的 labels 里逐条覆盖。搜索范围提示语不能两边共用一条：一个搜的是
  // 目录、另一个搜的是文件，措辞一样就等于又回到了「两个搜索框长得一模一样、范围却不同」
  // 那个问题。
  searchSubtree: '搜索这个目录下的全部目录…',
  newFolder: '新建文件夹',
  newFolderPlaceholder: '文件夹名',
  nameRequired: '名字不能为空',
  nameTaken: '这个名字已经被占用',
  title: '选择网盘目录',
  // sr-only，屏幕阅读器会把它和 title 一起读出来，必须说 title 没说的内容。
  description: '浏览下面的列表，选中一个目录后确认。',
  cancel: '取消',
  confirm: '选定此目录',
}

/** AList 条目 → 组件条目。size 塞进 meta 原样带回，组件自己从不读它。 */
function toEntries(files: Array<{ name: string; isDir: boolean; size: number }>): FileEntry[] {
  return files.map((f) => ({ name: f.name, isDir: f.isDir, meta: { size: f.size } }))
}

function joinAbs(base: string, name: string): string {
  return base === '/' || base === '' ? `/${name}` : `${base}/${name}`
}

/** 去尾斜杠，空串归一为根。绑定路径来自用户手敲的输入框，存量数据里真的有
 *  `dirPath='/夸克/剧集/'` 这种输入（后端 `/api/netdisk/fs` 路由自己也在用同一招
 *  `replace(/\/+$/,'')` 兜底，见 src/http/netdisk-routes.ts）。不规范化的话
 *  `` `${dirPath}/` `` 这类前缀拼接会双写斜杠，isWithinDir 的钳制和下面组件里剥
 *  相对名的逻辑都会算错。 */
function normalizeDirPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

/** candidate 是否等于 dirPath，或是它的子孙目录——路径钳制的唯一判据。导出给测试直接打（父目录/兄弟目录这类边界用例，底层 FileBrowser 的面包屑天然到不了，组件级测试模拟不出真实交互）。dirPath 先规范化再比较，调用方带没带尾斜杠不影响判定结果。 */
export function isWithinDir(candidate: string, dirPath: string): boolean {
  const dir = normalizeDirPath(dirPath)
  if (candidate === dir) return true
  const prefix = dir === '/' ? '/' : `${dir}/`
  return candidate.startsWith(prefix)
}

/** path 相对 dir 的名字；path 不在 dir 子树内就返回 null，调用方必须弃用整次提交。
 *  越界路径不能被静默改写成一个看着正常的相对名（`综艺/脱口秀/ep05.mp4`）——那是数据
 *  损坏，不是显示问题。眼下浏览路径已经被 isWithinDir 钳制在 dir 子树内，这条分支
 *  够不着，但同一份代码上面刚说过「不该把安全判据建立在一个现在恰好不可达的前提上」，
 *  onCommit 也不能例外。导出给测试直接打——理由和 isWithinDir 一样：组件级测试模拟
 *  不出「commit 一个越界 path」这个交互（正常浏览走不到那里）。 */
export function relativeToDir(path: string, dirPath: string): string | null {
  const dir = normalizeDirPath(dirPath)
  if (!isWithinDir(path, dir)) return null
  return dir === '/' ? path.slice(1) : path.slice(dir.length + 1)
}

/**
 * 「递归列举一次子树，按 path 缓存 Promise 复用」——两个弹窗共用这一份。
 *
 * AList 没有服务端搜索接口，跨子树搜索只能靠递归列举，是笔真开销。而 vendored
 * FileBrowser 驱动 loadDir/searchDir 的 effect 只按 path（以及 query）做依赖、没有防抖：
 * 不缓存就是「每敲一个字符全子树强刷一次」，在集数多的目录上是实打实的性能塌陷。
 *
 * `invalidate()` 给调用方在**弹窗重开**时清缓存用——不能只靠「path 变了才刷新」：AList 的
 * 目录列举有约 30 分钟缓存，上次打开时缓存下来的快照到这次重开时可能已经过期，而这两个
 * 弹窗的用途正是「对着网盘现状做人工选择」。同理每个 path 的第一次调用一律 `refresh: true`。
 */
function useRecursiveEntries(conn: Connection, opts: { dirs?: boolean } = {}) {
  const cacheRef = useRef<{ path: string; entries: Promise<FileEntry[]> } | null>(null)
  const dirs = opts.dirs
  const fetchRecursive = (path: string): Promise<FileEntry[]> => {
    if (cacheRef.current?.path !== path) {
      cacheRef.current = {
        path,
        entries: api.netdisk
          .listFs(conn, path, { recursive: true, refresh: true, dirs })
          .then((r) => toEntries(r.files)),
      }
      // 拉取失败不应该把「失败」永久缓存住——下一次查询要能重试，而不是反复复用同一个
      // 已经 reject 的 Promise。
      cacheRef.current.entries.catch(() => {
        if (cacheRef.current?.path === path) cacheRef.current = null
      })
    }
    return cacheRef.current.entries
  }
  return { fetchRecursive, invalidate: () => { cacheRef.current = null } }
}

/** 选一个网盘目录（绑定向导、认领文件夹、音频流挂目录都用它）。 */
export function NetdiskDirPickerDialog({
  apiBase = '',
  open,
  onOpenChange,
  initialPath = '/',
  onPick,
}: {
  apiBase?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  initialPath?: string
  onPick: (path: string) => void
}) {
  const conn: Connection = { baseUrl: apiBase }

  // Minor 5：复位到 initialPath 不能只靠 defaultPath（FileBrowser 内部的
  // useState(defaultPath) 只在挂载时生效一次）。DialogContent 在关闭动画（约 200ms）
  // 没跑完就重开时，Radix 的 Presence 会复用同一个节点、不走真正的卸载/重挂载，
  // defaultPath 因此不会重新生效，浏览路径会停在上次的位置。用和 NetdiskFilePickerDialog
  // 的 browsePath 同一个「渲染期发现 open 跳变」写法显式复位——不依赖调用方是否真的
  // 卸载了这个组件，和调用方怎么渲染它无关。改成受控 path，配对 onPathChange。
  const [path, setPath] = useState(initialPath)

  // 跨子树搜索用的递归结果（只要目录行）。**loadDir 不吃它**——这个弹窗必须能一层层
  // 走进去、在任意一层按「选定此目录」，改成递归平铺就没有「进去」这个动作了（文件那个
  // 弹窗产出的是一个文件名，才可以整棵子树摊平；这里产出的是一个目录路径）。
  //
  // 递归请求因此只由 searchDir 触发，而 FileBrowser 只在 query 非空时才调 searchDir——
  // 「等敲第一个字符才发」是天然的，不需要额外机关。这条很重要：从根目录搜等于把整个
  // 网盘走一遍（maxDepth=5 封顶），一打开就发这笔钱花得毫无理由。
  const { fetchRecursive, invalidate } = useRecursiveEntries(conn, { dirs: true })

  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setPath(initialPath)
      invalidate()
    }
  }

  return (
    <FilePickerDialog
      open={open}
      onOpenChange={onOpenChange}
      select="dir"
      path={path}
      onPathChange={setPath}
      labels={ZH}
      loadDir={async (p) => toEntries((await api.netdisk.listFs(conn, p)).files)}
      searchDir={(p, query) =>
        fetchRecursive(p).then((entries) => {
          const q = query.trim().toLowerCase()
          // 只留目录行：这个弹窗选的是目录，递归结果里的文件（后端同一个开关一起回的）
          // 出现在这里只会是噪声。命中项的 name 是相对 p 的子路径（`剧集/脱口秀`），
          // FileBrowser 用 joinPath(p, name) 导航——搜索正是以 p 为根发起的，所以拼出来
          // 就是正确的绝对路径。
          const dirs = entries.filter((e) => e.isDir)
          return q ? dirs.filter((e) => e.name.toLowerCase().includes(q)) : dirs
        })
      }
      onCreateFolder={async (parent, name) => { await api.netdisk.mkdir(conn, joinAbs(parent, name)) }}
      onCommit={(p) => onPick(p)}
    />
  )
}

/** 选一个网盘文件（手动订正某条清单的配对）。点中即提交，和旧行为一致。 */
export function NetdiskFilePickerDialog({
  apiBase = '',
  open,
  onOpenChange,
  dirPath,
  entryTitle,
  current = null,
  onPick,
}: {
  apiBase?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  dirPath: string
  /** 正在订正的清单条目标题。给出时拼进弹窗的可见标题，答上「正在给哪一条配文件」；
   *  省略则用通用标题——组件本身不认识「清单条目」这个概念。 */
  entryTitle?: string
  /** 当前已配的文件，相对 dirPath 的名字；给出时在列表里高亮它。未配传 null 或省略。 */
  current?: string | null
  onPick: (relativeName: string) => void
}) {
  const conn: Connection = { baseUrl: apiBase }
  // 规范化一次，全组件内统一使用——见 normalizeDirPath 上面的理由。isWithinDir 自己
  // 也会规范化它收到的 dirPath 参数（防御性，任何调用方都不会被尾斜杠坑），这里再
  // 规范化一次是幂等的，不是重复劳动：browsePath 的初值、value 的拼接、onCommit 的
  // 前缀剥离都要用同一份规范化结果，任何一处漏了都会和别处对不上。
  const dir = normalizeDirPath(dirPath)

  // 一打开就把 dir 整棵子树递归平铺出来——和旧 NetdiskFilePicker 的默认视图一致：
  // 订正嵌套在子目录里的一条清单条目（如「第3季/ep05.mp4」）只需一次点击，不需要先
  // 下钻 N 层再点、或者先打字搜索才够得着。recursive=1 回来的 name 已经是相对子
  // 路径（见 src/http/netdisk-routes.ts 里 /api/netdisk/fs 的注释），且这个模式下
  // 后端只返回文件、不返回目录行——所以这份列表天然没有可下钻的目录，下面
  // onPathChange 里的路径钳制因此退化成纯粹的保险丝（没有目录可点，正常情况下用不
  // 到它），不是删掉的理由：面包屑仍会渲染出 dir 以上的祖先层级，点它们必须被拦住。
  //
  // AList 没有服务端搜索接口，loadDir 和 searchDir 因此复用同一份递归列举（缓存与失效
  // 的理由见 useRecursiveEntries）——searchDir 只是在这份数据上按 query 做一次本层过滤
  // （组件本身对 query 的处理，和不传 searchDir 时 FileBrowser 自己的兜底过滤逻辑一致，
  // 唯一区别是这里的输入来自缓存而不是当前层级的 entries）。loadDir 的初次挂载和
  // searchDir 的每次按键全部复用同一份 entries，同一个 path 只发一次网络请求。
  //
  // 这里**不传 dirs**：后端 recursive 模式默认只回文件行，正是这个弹窗依赖的前提。
  const { fetchRecursive, invalidate } = useRecursiveEntries(conn)

  // 弹窗重开让缓存失效（理由同上），用和 vendored
  // FilePickerDialog 内部重置 `pending` 一样的「渲染期发现 open 跳变」写法，不依赖
  // 这个组件在关闭时是否真的被卸载（那取决于调用方怎么渲染它，这里不该假设）。
  // 受控浏览路径——这条 state 存在的唯一理由就是不让浏览翻出 dir 之外（见下面
  // onPathChange 的钳制注释）。弹窗重开必须把它复位到 dir，用和上面 cacheRef 同一个
  // 「渲染期发现 open 跳变」写法，理由相同（不依赖调用方是否真的卸载了这个组件）。
  const [browsePath, setBrowsePath] = useState(dir)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      invalidate()
      setBrowsePath(dir)
    }
  }

  return (
    <FilePickerDialog
      open={open}
      onOpenChange={onOpenChange}
      select="file"
      commitOnSelect
      path={browsePath}
      onPathChange={(next) => {
        // 业务钳制，不是编码细节：这个弹窗的 onPick 回的是「相对 dir 的名字」，
        // 调用点拿它当 rightFile 存进绑定。一旦浏览翻出 dir 之外，这个相对名
        // 的锚点就失去意义——选中的文件会带着错误的名字被绑到这条清单条目上，是
        // 数据损坏，不是显示问题。所以拦在源头：目标路径不是 dir 自己或它的
        // 子孙目录就直接忽略，浏览路径保持不动。眼下 loadDir/searchDir 都是递归
        // 平铺、没有目录行可点（见上面），这条分支平时够不着——但它是保险丝，不是
        // 废代码：面包屑仍会渲染出 dir 以上的祖先层级（因为 FileBrowser 从 '/'
        // 一路铺到 path），点它们必须被这里拦住，否则就是一次真的越界导航。
        //
        // 已知遗留瑕疵：那些祖先层级的面包屑按钮点了毫无反应（因为这里忽略了导航），
        // 而不是被禁用或隐藏。vendored 组件目前没有「根目录钳制」这个能力（它不知道
        // dir 是一个业务边界，只知道一个可以自由改变的 path），补这个能力应该在
        // @acrylic/file-picker 上游做，这里不做本地分叉。正确性优先于这条瑕疵——
        // 选错文件是数据损坏，死掉的面包屑只是难看。
        if (isWithinDir(next, dir)) setBrowsePath(next)
      }}
      labels={{
        ...ZH,
        // 「正在给哪一条配文件」必须肉眼可见——这个弹窗从一张几十行的清单里点开，
        // 关掉后唯一的后果就是把文件名写进那一行，界面上没有别的东西能把弹窗和
        // 那一行对上号。DialogTitle 是可见渲染（vendored FilePickerDialog 里的
        // <DialogTitle>），DialogDescription 是 sr-only——把 entryTitle 放进
        // description 等于只有屏幕阅读器读得到，肉眼看不见，所以放进 title。
        title: entryTitle ? `选择网盘文件 · ${entryTitle}` : '选择网盘文件',
        description: '浏览下面的列表，点选一个文件即可提交。',
        confirm: '选定此文件',
        // ZH 的基底说的是「全部目录」（那个弹窗搜的是目录）——这里搜的是文件。
        searchSubtree: '搜索这个目录下的全部文件…',
      }}
      value={current != null ? joinAbs(dir, current) : undefined}
      loadDir={fetchRecursive}
      searchDir={(path, query) =>
        fetchRecursive(path).then((entries) => {
          const q = query.trim().toLowerCase()
          return q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries
        })
      }
      onCommit={(path) => {
        const relative = relativeToDir(path, dir)
        // 越界（path 不在 dir 子树内）就是已经出错了：宁可不写，也不要把它静默改写成
        // 一个看着完全正常的相对名（如 `综艺/脱口秀/ep05.mp4`）再被 PATCH 进绑定——那是
        // 数据损坏，不是显示问题。见 relativeToDir 上面的理由。
        if (relative !== null) onPick(relative)
      }}
    />
  )
}
