import type { MatchSpec, MatchStage } from '../types.ts'
import type { SpecLeft, SpecRight } from '../match-spec.ts'
import {
  specStages, stripper, normTitle, normFile, fileBase, contentContradicts,
  DEFAULT_TITLE_STRIP, DURATION_TOLERANCE_S,
} from '../match-spec.ts'
import { gramsOf, diceFromIntersection } from '../../text/similarity.ts'
import type { EvidenceEdge, EvidenceGraph, Fact, FileNode, LeftNode, LeftStructKey, StripId, StructKeyKind } from './types.ts'

const CN_DIGITS: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
/** 期号/段号归一化：`03` → `3`，`三` → `3`，`十二` → `12`；不是数字的（上/中/下）原样返回。
 *  只到几十——期号没有上百的综艺，段号更不会。 */
export function cnNumber(s: string): string {
  if (/^\d+$/.test(s)) return String(Number(s))
  if (!/^[一二三四五六七八九十]+$/.test(s)) return s
  if (s.length === 1) return String(CN_DIGITS[s])
  // 十X / X十 / X十Y
  const i = s.indexOf('十')
  if (i === -1) return s
  const tens = i === 0 ? 1 : CN_DIGITS[s[0]!] ?? 0
  const ones = i === s.length - 1 ? 0 : CN_DIGITS[s[s.length - 1]!] ?? 0
  return String(tens * 10 + ones)
}

/**
 * ① 证据层：`collectEvidence(spec, left, right) → EvidenceGraph`（spec §3.1）。
 *
 * **铁律**：证据器只吐事实，不许认领、不许丢弃、不许下结论。清洗口径**不许自带一份**——
 * `stripper`/`normTitle`/`normFile`/`fileBase` 全部从 `match-spec.ts` import，
 * 两份清洗器就是两个脑（P7）。
 */

/**
 * 三个采集相位。**为什么不是"全部证据器互不相干"**（spec §3.1 铁律的字面版）：
 * 时长矛盾与字节孪生是**关于已在场的那对**的补充事实，对全体 L×F 铺开只会造出一张全连接图
 * （几十万条"这俩不是一集"的废边）。相位把这件事说清楚：
 *
 *  - `seed`   互不相干，**建边**。彼此看不见对方的产出——铁律在这一相位严格成立。
 *  - `enrich` 名字：给**已有的每条边**补上本口径的名字分（裁决层要用它比门槛），
 *             并对分数过记录地板（`NAME_RECORD_FLOOR`）的对**另外建边**。
 *  - `annotate` 只往**已有边**上加事实，绝不建边、绝不删边。
 *
 * 相位只读"这对有没有边"，不读别的证据器写了什么事实——铁律真正防的是"证据器互相下结论"。
 */
export type CollectPhase = 'seed' | 'enrich' | 'annotate'

export interface EvidenceCollector {
  id: string
  phase: CollectPhase
  run(b: GraphBuilder): void
}

/**
 * 名字证据的**记录地板**：相似度低于它的对不建边。
 * 这是**记录密度**参数（防 L×F 全连接爆炸），不是裁决门槛——别和 `DURATION_MIN_SIM`(0.3) 混。
 */
export const NAME_RECORD_FLOOR = 0.05

// ─────────────────────────────────────────────────────────────────────────────
// 图构建器
// ─────────────────────────────────────────────────────────────────────────────

const edgeId = (leftKey: string, path: string) => `${leftKey}\u0000${path}`

/** 建图的可写视图。证据器只经它落事实——顺序、去重、"能不能建边"这三件事都在这里统一。 */
export class GraphBuilder {
  readonly lefts: LeftNode[]
  readonly files: FileNode[]
  readonly leftStructKeys: LeftStructKey[] = []
  readonly strips: Record<StripId, string[]> = {}
  private readonly byId = new Map<string, EvidenceEdge>()
  /** 输入顺序的索引——边集按 (左序, 右序) 排定，保证同一份输入每次跑出逐字相同的图。 */
  private readonly leftIx = new Map<string, number>()
  private readonly fileIx = new Map<string, number>()

  constructor(lefts: LeftNode[], files: FileNode[]) {
    this.lefts = lefts
    this.files = files
    lefts.forEach((l, i) => this.leftIx.set(l.leftKey, i))
    files.forEach((f, i) => this.fileIx.set(f.path, i))
  }

  hasEdge(leftKey: string, path: string): boolean { return this.byId.has(edgeId(leftKey, path)) }

  /** 已有边的快照（annotate/enrich 相位遍历用）。返回数组而非迭代器：相位内可能建新边。 */
  edgeList(): EvidenceEdge[] { return [...this.byId.values()] }

  /**
   * 落一条事实。`create: false` = 只往已有边上加（annotate 相位的硬约束，
   * 越过它就等于让"不沾边"这件事自己建边，图会退化成全连接）。
   */
  addFact(leftKey: string, path: string, fact: Fact, create: boolean): void {
    const id = edgeId(leftKey, path)
    const existing = this.byId.get(id)
    if (existing) { existing.facts.push(fact); return }
    if (!create) return
    this.byId.set(id, { leftKey, path, facts: [fact] })
  }

  noteLeftStructKey(leftKey: string, key: StructKeyKind, value: string): void {
    this.leftStructKeys.push({ leftKey, key, value })
  }

  /** 登记一套清洗口径，返回它的 id（同一份 `titleStrip` 只登记一次）。 */
  registerStrip(titleStrip: string[]): StripId {
    const sig = JSON.stringify(titleStrip)
    for (const [id, patterns] of Object.entries(this.strips)) if (JSON.stringify(patterns) === sig) return id
    const id = `S${Object.keys(this.strips).length}`
    this.strips[id] = titleStrip
    return id
  }

  build(): EvidenceGraph {
    const edges = [...this.byId.values()].sort((a, b) =>
      (this.leftIx.get(a.leftKey)! - this.leftIx.get(b.leftKey)!) || (this.fileIx.get(a.path)! - this.fileIx.get(b.path)!))
    return {
      edges,
      files: this.files.map((f) => f.path),
      lefts: this.lefts.map((l) => l.leftKey),
      fileMeta: new Map(this.files.map((f) => [f.path, f])),
      leftMeta: new Map(this.lefts.map((l) => [l.leftKey, l])),
      leftStructKeys: this.leftStructKeys,
      strips: this.strips,
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 证据器
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 时长命中（seed）。只做"量"这一件事（`|Δ| <= toleranceS`），**到"量到了"为止**：
 * 唯一性、名字地板、零竞争全是裁决层的事，证据器不许下结论。
 *
 * 索引按时长排序 + 二分开窗（spec §3.1「省时间不省记录」）：窗内每对都出边，一条不漏。
 */
export function durationCollector(toleranceS: number): EvidenceCollector {
  return {
    id: 'duration-hit',
    phase: 'seed',
    run(b) {
      const timed = b.files.filter((f) => typeof f.durationS === 'number').sort((x, y) => x.durationS! - y.durationS!)
      if (timed.length === 0) return
      const ds = timed.map((f) => f.durationS!)
      for (const l of b.lefts) {
        if (typeof l.durationS !== 'number') continue
        for (let i = lowerBound(ds, l.durationS - toleranceS); i < ds.length && ds[i] <= l.durationS + toleranceS; i++) {
          b.addFact(l.leftKey, timed[i].path, { kind: 'duration', state: 'hit', deltaS: Math.abs(ds[i] - l.durationS), toleranceS }, true)
        }
      }
    },
  }
}

function lowerBound(sorted: number[], target: number): number {
  let lo = 0, hi = sorted.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < target) lo = mid + 1; else hi = mid }
  return lo
}

/**
 * 结构键（seed）。三种键共用一套骨架——**两侧读出同一个键值才建边**，这就是"按键分桶、
 * 桶内消歧"里**分桶**那一半（R6/R7/R8）。桶内怎么挑仍归裁决层。
 *
 * 左侧读不出键（无号项、非 tmdb 左键）→ 该集在本档无信号，原样留给后续规则。
 * 左侧读得出、右侧一个文件都没有 → 没有边，但键记进 `leftStructKeys`：那是缺档的定义。
 */
export function structKeyCollector(
  key: StructKeyKind,
  keyOfLeft: (l: LeftNode) => string | null,
  keyOfFile: (f: FileNode) => string | null,
): EvidenceCollector {
  return {
    id: `struct-key:${key}`,
    phase: 'seed',
    run(b) {
      const filesByKey = new Map<string, FileNode[]>()
      for (const f of b.files) {
        const k = keyOfFile(f); if (k == null) continue
        const arr = filesByKey.get(k) ?? []; arr.push(f); filesByKey.set(k, arr)
      }
      for (const l of b.lefts) {
        const k = keyOfLeft(l); if (k == null) continue
        b.noteLeftStructKey(l.leftKey, key, k)
        for (const f of filesByKey.get(k) ?? []) b.addFact(l.leftKey, f.path, { kind: 'struct-key', key, value: k }, true)
      }
    },
  }
}

/**
 * 名字（enrich）。一份 `titleStrip` 一个实例——各 stage 可以各配一份口径，裁决层比门槛时
 * 必须拿**本规则那把尺**量出来的分（见 `StripId` 头注）。
 *
 * 两件事一起做：
 *  1. 给**已有的每条边**补名字分（哪怕 0 分）。结构键桶里的候选正是靠这个分做桶内消歧，
 *     而它常常低于记录地板——地板管的是"建不建边"，不是"记不记分"。
 *  2. 分数 ≥ 地板的对**另外建边**：这是 `title` 档的候选来源。
 *     标题档的候选本可以是**全部**未占用文件（含 0 分的），这里只收过地板的——
 *     两者对结果不可分辨：0 分候选既进不了 `best`（title 阈值 0.85），也改不了 margin 判定
 *     （次佳 ≤ 地板 0.05 时，`best - 次佳` 与 `best - 0` 同侧），而 title 档 `markAmbiguous=false`
 *     连落配证据都不记。金样对照的随机扰动组专门压这条。
 */
export function nameCollector(stripId: StripId, titleStrip: string[]): EvidenceCollector {
  return {
    id: `name:${stripId}`,
    phase: 'enrich',
    run(b) {
      const pre = stripper(titleStrip)
      const cl = b.lefts.map((l) => normTitle(pre, l.title))
      const cr = b.files.map((f) => normFile(pre, f.path))

      /**
       * bigram 倒排索引。**为什么不逐对 `titleSim`**：那是 L×F 次调用、每次现建两张 bigram 表，
       * 同一个文件名的表会被重建上千遍（实测 1000 集 × 300 文件要 750ms，spec §3.1 的预算是 500ms
       * 整轮）。倒排后每个串只切一次 bigram，且**零交集的对根本不进循环**——真实语料里那是大多数。
       * 数值仍由 `diceFromIntersection` 收口，与 `titleSim` 逐位相同。
       */
      const postings = new Map<string, { fi: number; count: number }[]>()
      const fileGrams = cr.map(gramsOf)
      fileGrams.forEach((g, fi) => {
        for (const [gram, count] of g) {
          const arr = postings.get(gram) ?? []; arr.push({ fi, count }); postings.set(gram, arr)
        }
      })

      const factFor = (a: string, z: string, score: number): Fact =>
        a.length > 0 && a === z
          ? { kind: 'name', method: 'identity-exact', score: 1, cleanedLeft: a, cleanedRight: z, stripId }
          : { kind: 'name', method: 'sim', score, cleanedLeft: a, cleanedRight: z, stripId }

      b.lefts.forEach((l, li) => {
        const a = cl[li]
        const inter = new Map<number, number>()
        for (const [gram, ca] of gramsOf(a)) {
          for (const p of postings.get(gram) ?? []) inter.set(p.fi, (inter.get(p.fi) ?? 0) + Math.min(ca, p.count))
        }
        b.files.forEach((f, fi) => {
          const z = cr[fi]
          const has = b.hasEdge(l.leftKey, f.path)
          /**
           * 零交集的对：只有当它已经有别的事实边时才需要补一条 0 分（裁决层要拿它做桶内消歧）。
           *
           * **`a === z` 必须先放行**：倒排索引的键是 bigram，而**长度 1 的串一个 bigram 都没有**
           * ——两边清洗后都是「甲」这种单字标题，交集恒空，边就永远建不起来，一个逐字相同的
           * 名字反而配不上（`diceFromIntersection`/`titleSim` 对相等的串短路返回 1，这里却
           * 走不到那一步）。判据只能是"串相等"，不能靠交集非空推出来。
           */
          if (!has && !inter.has(fi) && a !== z) return
          const score = diceFromIntersection(a, z, inter.get(fi) ?? 0)
          if (!has && score < NAME_RECORD_FLOOR) return
          b.addFact(l.leftKey, f.path, factFor(a, z, score), !has)
        })
      })
    },
  }
}

/**
 * 时长矛盾（annotate）。判据是 `contentContradicts`（相对差 > `CONTENT_MISMATCH_RATIO`），
 * **从 `match-spec.ts` import**——R11 横向闸门用的就是这一个函数，
 * 判据一分家就是第二个判定脑（P7）。
 *
 * 只给**已有边**加：无名字牵扯、无结构键、无时长命中的两个东西"不是一集"，是废话不是证据，
 * 铺开就是 L×F 条全连接边。
 */
export function durationContradictCollector(toleranceS: number): EvidenceCollector {
  return {
    id: 'duration-contradict',
    phase: 'annotate',
    run(b) {
      const ldOf = new Map(b.lefts.map((l) => [l.leftKey, l.durationS]))
      const rdOf = new Map(b.files.map((f) => [f.path, f.durationS]))
      for (const e of b.edgeList()) {
        const ld = ldOf.get(e.leftKey)
        const rd = rdOf.get(e.path)
        if (!contentContradicts(ld, rd)) continue
        b.addFact(e.leftKey, e.path, { kind: 'duration', state: 'contradict', deltaS: Math.abs(ld! - rd!), toleranceS }, false)
      }
    },
  }
}

/**
 * 字节孪生（annotate，恒开，无对应 stage）。同字节数 + 双方时长相同或同缺 = 同一份内容的
 * 另一拷贝。挂法见 `Fact.byte-identity` 头注。
 *
 * 05 案就靠它把"这份 96 分钟的文件和 005 的正主字节全等"说出口——这条信息一度压根不存在，
 * 于是卡片只能说"时长和名字都对不上"这句假话。
 */
export function byteIdentityCollector(): EvidenceCollector {
  return {
    id: 'byte-identity',
    phase: 'annotate',
    run(b) {
      const bySize = new Map<number, FileNode[]>()
      for (const f of b.files) {
        if (typeof f.sizeBytes !== 'number') continue
        const arr = bySize.get(f.sizeBytes) ?? []; arr.push(f); bySize.set(f.sizeBytes, arr)
      }
      const twins = new Map<string, string[]>()
      for (const group of bySize.values()) {
        if (group.length < 2) continue
        for (const a of group) {
          const peers = group.filter((z) => z.path !== a.path && z.durationS === a.durationS)
          if (peers.length) twins.set(a.path, peers.map((z) => z.path))
        }
      }
      if (twins.size === 0) return
      for (const e of b.edgeList()) {
        for (const peer of twins.get(e.path) ?? []) b.addFact(e.leftKey, e.path, { kind: 'byte-identity', peerPath: peer }, false)
      }
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 装载
// ─────────────────────────────────────────────────────────────────────────────

/** tmdb 剧集 leftKey(`tmdb:<id>:S01E02`) 末尾的季集 → `季:集`。非此形状（播客/订阅流键）→ null。 */
const LEFT_SE = /:S(\d{1,3})E(\d{1,4})$/i

/**
 * 按 `matchSpec.stages` 实例化证据器（spec §3.1 映射表），存量 spec 零迁移。
 * `specStages` 的**隐式时长锚**语义原样保留：没声明 `duration` 的谱自动补一档、且排在最前
 * （见 `match-spec.ts:withDurationAnchor`——补进来那档的 `titleStrip` 是各档并集）。
 *
 * `solo` 不产证据器：那一档没有"标题相似度"这个语义，它读的是节点（唯一左项 × 视频文件 ×
 * 体量），归裁决层的 R10。
 */
export function fromSpec(spec: MatchSpec, b: GraphBuilder): EvidenceCollector[] {
  const out: EvidenceCollector[] = []
  const strips: string[][] = []
  const addStrip = (s: string[]) => { if (!strips.some((x) => JSON.stringify(x) === JSON.stringify(s))) strips.push(s) }
  let toleranceS = DURATION_TOLERANCE_S

  for (const stage of specStages(spec)) {
    if (stage.by !== 'solo') addStrip(stage.titleStrip)
    switch (stage.by) {
      case 'duration': {
        toleranceS = stage.toleranceS
        out.push(durationCollector(stage.toleranceS))
        break
      }
      case 'epnum': {
        const pre = stripper(stage.titleStrip)
        const re = new RegExp(stage.epNumRegex)
        const numIn = (cleaned: string) => { const m = re.exec(cleaned); return m ? String(Number(m[1])) : null }
        out.push(structKeyCollector('epnum',
          (l) => numIn(pre(l.title)),
          (f) => numIn(pre(fileBase(f.path)))))
        break
      }
      case 'episode-part': {
        const pre = stripper(stage.titleStrip)
        const re = new RegExp(stage.keyRegex)
        // 第 1 组是期号，第 2 组起任一组是分段（默认正则四种写法各占一组，自定义谱可以只有一组）。
        // 两侧都归一化：中文数字 → 阿拉伯数字（「（三）」与「3」是同一段），上/中/下原样。
        const keyIn = (cleaned: string) => {
          const m = re.exec(cleaned)
          if (!m || m[1] == null) return null
          const part = m.slice(2).find((g) => g != null)
          if (part == null) return null
          return `${cnNumber(m[1])}:${cnNumber(part.trim().toLowerCase())}`
        }
        out.push(structKeyCollector('episode-part',
          (l) => keyIn(pre(l.title)),
          (f) => keyIn(pre(fileBase(f.path)))))
        break
      }
      case 'season-episode': {
        const pre = stripper(stage.titleStrip)
        const re = new RegExp(stage.fileRegex)
        // 单捕获组的 fileRegex → 整档退化成"纯按集号分桶"（网盘按季分文件夹、文件裸到只剩集号）。
        // **发现即用、不逐文件切换口径**：整档退化成"纯按集号分桶"，不逐文件切换。
        let episodeOnly = false
        for (const f of b.files) { const m = re.exec(pre(fileBase(f.path))); if (m?.[1] != null && m[2] == null) episodeOnly = true }
        out.push(structKeyCollector('season-episode',
          (l) => {
            const m = LEFT_SE.exec(l.leftKey)
            if (!m) return null
            return episodeOnly ? `E${Number(m[2])}` : `${Number(m[1])}:${Number(m[2])}`
          },
          (f) => {
            const m = re.exec(pre(fileBase(f.path)))
            if (m?.[1] == null) return null
            return m[2] != null ? `${Number(m[1])}:${Number(m[2])}` : `E${Number(m[1])}`
          }))
        break
      }
      case 'title': break // 名字证据器按口径统一装（见下），title 档只是它的一个消费者
      case 'solo': break
    }
  }

  if (strips.length === 0) addStrip(DEFAULT_TITLE_STRIP)
  for (const s of strips) out.push(nameCollector(b.registerStrip(s), s))
  out.push(durationContradictCollector(toleranceS), byteIdentityCollector())
  return out
}

const PHASES: CollectPhase[] = ['seed', 'enrich', 'annotate']

/**
 * 跑一轮证据收集。**纯函数**：不吃 IO、不看时钟，同一份输入永远同一张图。
 *
 * `right` 的 `name` 在图里叫 `path`——两侧消费者传进来的可能是相对子路径（绑定同步）也可能是
 * 绝对路径（归档器），命名空间由调用方保证一致（见 `SpecLeft.pinnedRight`）。
 */
export function collectEvidence(spec: MatchSpec, left: SpecLeft[], right: SpecRight[]): EvidenceGraph {
  const lefts: LeftNode[] = left.map((l) => ({
    leftKey: l.leftKey, title: l.title,
    ...(l.durationS != null ? { durationS: l.durationS } : {}),
    ...(l.paid != null ? { paid: l.paid } : {}),
    // 缺席 = 要供货（保守档）：折成缺席与折成 `true` 在裁决层同义，别在这里替调用方补默认。
    ...(l.needsSupply != null ? { needsSupply: l.needsSupply } : {}),
    ...(l.pinnedRight != null ? { pinnedRight: l.pinnedRight } : {}),
  }))
  const files: FileNode[] = right.map((r) => ({
    path: r.name,
    ...(r.size != null ? { sizeBytes: r.size } : {}),
    ...(r.durationS != null ? { durationS: r.durationS } : {}),
  }))
  const b = new GraphBuilder(lefts, files)
  const collectors = fromSpec(spec, b)
  for (const phase of PHASES) for (const c of collectors) if (c.phase === phase) c.run(b)
  return b.build()
}

/** 本谱生效的时长容差（裁决层的 R12 收尾要用同一个数）。 */
export function toleranceOf(spec: MatchSpec): number {
  const d = specStages(spec).find((s): s is Extract<MatchStage, { by: 'duration' }> => s.by === 'duration')
  return d?.toleranceS ?? DURATION_TOLERANCE_S
}
