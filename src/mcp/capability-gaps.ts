/**
 * 「这件事为什么做不了、谁能修」——`capability_status` 工具的脑，纯函数，读口全部注入。
 *
 * 它回答的不是一个布尔。用户手里其实有三种完全不同的下一步，而「不可用」这一个字把它们糊在
 * 一起：**能用** / **缺一把钥匙、而且我们能替他去申请**（有一条 recipe 声明自己产出那一格
 * 配置）/ **缺一把钥匙、只能他自己去拿**（没有任何 recipe 能产出，只能给他链接）。第四种是
 * 「压根不是缺钥匙」（机器上没装 ffmpeg、梯子上一个成员都没有、钥匙已经在了但后端还没重启）
 * ——**它必须和前两种分开**：对这一档说「我帮你申请一把 key」是指错路，而指错路不会报错，
 * 模型会照着走进死胡同（`docs/AGENT-TOOLING.md` §8）。
 *
 * **能力的可用性只有一个真相源**：`conversions.kinds()` 里 extract 那一行的 `branches`
 * ——就是后端真正用来选分支的那份判据（`shared/extract/plan.ts` 吃它）。这里绝不另造一个
 * 「看着像配好了」的嗅探。
 *
 * **「谁能修」也不另立名单**：从这条能力骑的那一行 Provider 的成员反查——声明的成本阶梯
 * （`src/providers/system/<row>.ts` 的 `defaultMembers`）∪ 用户库里现有的成员，逐个问它的
 * manifest 要哪一格 `runtime_config`。所以这里没有任何一个具体站点的名字：groq 是
 * `transcribe` 那条阶梯的第一档，不是这个模块认识的东西。
 */

/** 一格配置在这台机器上的样子。**只报层，从不报值。** */
export interface ConfigSlotView {
  /** `runtime_config.ref`，也是 `provision_capability_key` 要的那个参数。 */
  ref: string
  /** 人看的名字，如 `Groq API Key`。 */
  label: string
  /** 那一格里的 secret 字段名。 */
  field: string
  configured: boolean
  /** 用户自己去拿这把钥匙的地址（manifest 的 `helpUrl`）。 */
  help_url?: string
  /** 能替他跑一趟的那条 recipe；null = 只能他自己配。 */
  provisioner: {
    sourceId: string
    label: string
    /** 会在用户自己的 Chrome 里打开的那一页。 */
    entryUrl: string
    field: string
    paramsSchema: Record<string, unknown>
  } | null
}

export type CapabilityBlocker =
  /** 缺一格配置。`can_provision` 就是「我们能不能替他去申请」。 */
  | { kind: 'config'; ref: string; label: string; field: string; can_provision: boolean; help_url?: string; message: string }
  /** 机器上缺一个外部命令（ffmpeg…）。给钥匙也修不好。 */
  | { kind: 'tool'; tool: string; message: string }
  /** 这条能力骑的那一行 Provider 上一个成员都没有，且没有任何一格配置能解释它。 */
  | { kind: 'no-members'; message: string }
  /** 钥匙已经在了，但这条梯子是后端启动那一刻定的——再申请一把也没用，要重启。 */
  | { kind: 'restart'; message: string }

export type CapabilityState =
  | 'ready'
  /** 缺钥匙，且至少有一格我们能替他申请 → 引导他二选一。 */
  | 'needs-key-self-serve'
  /** 缺钥匙，但没有任何 recipe 能产出 → 只能给他链接自己配。 */
  | 'needs-key-manual'
  /** 不是缺钥匙那一类。**绝不能在这一档提申请**。 */
  | 'blocked-other'

export interface CapabilityView {
  id: string
  label: string
  state: CapabilityState
  available: boolean
  /** 一句人话，可以直接念给用户听。 */
  why: string
  /** 这条能力认得的**全部**配置格（含已经配好的）——梯子上任一格配好即可。 */
  keys: ConfigSlotView[]
  keys_mode: 'any'
  /** 全部拦路虎，逐条列。`state` 只是头条，别只读它。 */
  blockers: CapabilityBlocker[]
}

export interface CapabilitySpec {
  id: string
  label: string
  /** 可用性读 `conversions.kinds()` 里 extract 那一行的这个分支。 */
  branch: string
  /** 配置格从这一行 Provider 的成员反查。 */
  row: string
  /** 除了钥匙，这条能力还要机器上有哪些外部命令。 */
  tools: string[]
  /** 一句话说清这条能力是干什么的（回执里给模型的措辞底子）。 */
  does: string
}

/**
 * 今天在工具面上答得了的那几条能力。
 *
 * 三条都是 `extract` 的分支——因为 extract 是全仓唯一把「这条能力此刻可不可用」写成结构化
 * 自述（`branches`）的地方。往这张表里加一行之前先回答：**它的可用性有没有一个不撒谎的读口**？
 * 没有就别加——一个靠猜的 `available` 比没有这一行更坏。
 */
export const CAPABILITY_SPECS: CapabilitySpec[] = [
  {
    id: 'transcribe',
    label: '语音转文字（转写）',
    branch: 'stt',
    row: 'transcribe',
    tools: ['ffmpeg'],
    does: '把视频/音频/播客转成带时间轴的文字稿',
  },
  {
    id: 'ocr',
    label: '图片 / PDF 认字',
    branch: 'ocr',
    row: 'parse',
    tools: [],
    does: '把图片、截图、PDF 上的字读出来',
  },
  {
    id: 'article',
    label: '网页正文抓取',
    branch: 'article',
    row: 'article-extract',
    tools: [],
    does: '把一条链接抓成正文 markdown',
  },
]

/** 一份 `runtime_config` 声明的结构子集——这里只用得着 ref 与 secret 字段的展示信息。 */
export interface RuntimeConfigLike {
  ref: string
  fields: Record<string, { type: string; label?: string; helpUrl?: string }>
}

/**
 * 一个 Provider 成员的 manifest → 它要的那一格配置。
 *
 * `ref` **由调用方给**（`credentials/key-state.ts` 的 `keyRefOf`：perInstance 源的 key 不在
 * `rc.ref` 那一层，而在成员自己的 `params.tokenName`）——别在这里拿 `rc.ref` 顶替它，那正是
 * 「读到的永远是 missing」那个假读数的来路。
 *
 * 返回 null = 这个成员根本没有 secret 字段（不该被算成「缺 key」）。
 */
export function slotOf(
  rc: RuntimeConfigLike | undefined,
  ref: string | null,
  keyState: 'stored' | 'env' | 'missing' | null,
  provisionerOf: (ref: string) => ConfigSlotView['provisioner'],
): ConfigSlotView | null {
  if (!rc || !ref || keyState === null) return null
  const entry = Object.entries(rc.fields).find(([, f]) => f.type === 'secret')
  if (!entry) return null
  const [field, spec] = entry
  return {
    ref,
    label: spec.label ?? ref,
    field,
    configured: keyState !== 'missing',
    ...(spec.helpUrl ? { help_url: spec.helpUrl } : {}),
    provisioner: provisionerOf(ref),
  }
}

export interface CapabilityReaders {
  /** extract 的这条分支此刻可不可用。**读 `conversions.kinds()`，别另造判据。** */
  branchAvailable: (branch: string) => boolean
  /** 这一行 Provider 的成员各要哪一格配置（声明的阶梯 ∪ 库里现有的成员）。 */
  slotsOf: (row: string) => ConfigSlotView[]
  /** 这台机器上有没有这个外部命令。 */
  toolAvailable: (tool: string) => boolean
}

function viewOf(spec: CapabilitySpec, readers: CapabilityReaders): CapabilityView {
  const keys = readers.slotsOf(spec.row)
  const available = readers.branchAvailable(spec.branch)
  if (available) {
    return {
      id: spec.id, label: spec.label, state: 'ready', available: true,
      why: `${spec.label}现在能用（${spec.does}）。`,
      keys, keys_mode: 'any', blockers: [],
    }
  }

  const blockers: CapabilityBlocker[] = []
  for (const tool of spec.tools) {
    if (!readers.toolAvailable(tool)) {
      blockers.push({
        kind: 'tool', tool,
        message: `这台机器上找不到 ${tool}。这一档给多少把 key 都修不好——要用户自己装上它（或换一台装了的机器）。`,
      })
    }
  }
  const missing = keys.filter((k) => !k.configured)
  if (!keys.length) {
    blockers.push({
      kind: 'no-members',
      message: `${spec.label}骑的那一行（${spec.row}）上一个能用的成员都没有，而且没有任何一格 API key 能解释它——`
        + '这不是缺钥匙，要用户去「设置 - Providers」给这一行加成员。',
    })
  } else if (!missing.length && !blockers.length) {
    // 钥匙齐了、外部命令也在，却仍然不可用：这一行是后端启动那一刻按「哪些 key 在」定的
    // （`src/providers/seed.ts` 的 `ensureTranscribeRow`），配完不重启挂不上。
    // **这一档尤其要说清**：用户刚点完「帮我申请」，看到还是不可用，最容易被解释成申请失败。
    blockers.push({
      kind: 'restart',
      message: `钥匙已经配上了（${keys.filter((k) => k.configured).map((k) => k.label).join('、')}），但这条梯子是后端启动那一刻定的——`
        + '重启一次后端它才挂得上。再申请一把 key 没有用。',
    })
  }
  for (const k of missing) {
    blockers.push({
      kind: 'config', ref: k.ref, label: k.label, field: k.field,
      can_provision: !!k.provisioner, ...(k.help_url ? { help_url: k.help_url } : {}),
      message: k.provisioner
        ? `缺 ${k.label}。可以用 provision_capability_key({ref:"${k.ref}"}) 替用户在 ${k.provisioner.entryUrl} 上建一把，`
          + `也可以让他自己去 ${k.help_url ?? k.provisioner.entryUrl} 拿了填进设置里。`
        : `缺 ${k.label}，而且没有任何 recipe 能替他申请——只能让他自己去 ${k.help_url ?? '发行方的控制台'} 拿一把，填进「设置 - 源配置」。`,
    })
  }

  // 头条的判法：**只要有一条不是「缺钥匙」，就不许报成能替他申请**——那是指错路。
  const state: CapabilityState =
    blockers.some((b) => b.kind !== 'config') ? 'blocked-other'
      : blockers.some((b) => b.kind === 'config' && b.can_provision) ? 'needs-key-self-serve'
        : 'needs-key-manual'

  const why =
    state === 'blocked-other'
      ? `${spec.label}现在用不了，而且不是缺 API key 的问题：${blockers.filter((b) => b.kind !== 'config').map((b) => b.message).join(' ')}`
      : state === 'needs-key-self-serve'
        ? `${spec.label}现在用不了，缺的是 API key，而且我们能替用户去申请（见 blockers 里 can_provision:true 的那几格）。`
        : `${spec.label}现在用不了，缺的是 API key，但没有任何 recipe 能替他申请——只能给他链接自己配。`

  return { id: spec.id, label: spec.label, state, available: false, why, keys, keys_mode: 'any', blockers }
}

export function diagnoseCapabilities(
  readers: CapabilityReaders,
  specs: CapabilitySpec[] = CAPABILITY_SPECS,
): { capabilities: CapabilityView[] } {
  return { capabilities: specs.map((s) => viewOf(s, readers)) }
}
