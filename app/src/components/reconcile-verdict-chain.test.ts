import { describe, expect, it } from 'vitest'
import { conflictCandidatesOf, kbpsBaselineOf, verdictChainOf } from './reconcile-verdict-chain.ts'
import type { ExplainEdge, MatchFact, ReconcilePlanAction, RowExplain } from '../lib/types.ts'

/**
 * 判据链：把「凭什么这么判 / 凭什么问你」从一段散文，换成一列带实测值的信号。
 *
 * **数据全部来自后端已有的判决书**（`explain.edges[].facts`），前端一个字段都不新造、
 * 一个数都不重算——这条与 `types.ts` 里那段"后端是唯一真相源"的约定是同一条。
 * 所以本文件的 fixture 一律抄活体真值（2026-08-03 怡楽播客那一轮），不手编好看的数：
 * 编出来的 fixture 只能证明代码自洽，证明不了它读得懂真数据。
 */

/** `leftKey` 必须是真 key：主边靠它认（集名是展示值，同名的两集在别的节目单里真会出现）。 */
const edge = (
  leftKey: string,
  title: string,
  durationS: number | undefined,
  facts: MatchFact[],
  rest: Partial<Pick<ExplainEdge, 'outcome' | 'vetoReason' | 'rule'>> = {},
): ExplainEdge => ({
  episode: { leftKey, title, durationS },
  facts,
  outcome: rest.outcome ?? 'vetoed',
  vetoReason: rest.vetoReason,
  rule: rest.rule,
})

// ── 活体真值：/quark/From Stream/怡楽播客/付费/116.安特卫普金库案.mp3 ──────────
const collideAction: ReconcilePlanAction = {
  kind: 'pending', key: '116安特卫普金库案', origin: 'authority', pendingKind: 'duration-collision',
  src: { path: '/lib/付费/116.安特卫普金库案.mp3', name: '116.安特卫普金库案.mp3', size: 127759079, durationS: 3194 },
  episode: '116.安特卫普金库案', collidesWith: 'item:f7efb1c865329784',
  compare: { authorityDurationS: 3551, candidates: [{ path: '/lib/付费/116.安特卫普金库案.mp3', size: 127759079, durationS: 3194, inLib: true }] },
  basis: 'ambiguous:duration-contradiction:item:f7efb1c865329784',
  reason: '名字与「116.安特卫普金库案」对得上，时长却差出量级——……',
}
const collideExplain: RowExplain = {
  file: { path: '/lib/付费/116.安特卫普金库案.mp3', sizeBytes: 127759079, durationS: 3194, kbps: 320 },
  edges: [edge('item:f7efb1c865329784', '116.安特卫普金库案', 3551, [
    { kind: 'struct-key', key: 'epnum', value: '116' },
    { kind: 'name', method: 'identity-exact', score: 1, cleanedLeft: '安特卫普金库案', cleanedRight: '安特卫普金库案', stripId: 'S0' },
    { kind: 'duration', state: 'contradict', deltaS: 357, toleranceS: 1 },
  ], { vetoReason: 'duration-contradict', rule: 'R11' })],
  truncatedCount: 1,
  verdict: { disposition: 'residual' },
}

// ── 活体真值：/quark/From Stream/怡楽播客/付费/玄关笔记/05.太极两仪生四象.mp3 ──
const redundantAction: ReconcilePlanAction = {
  kind: 'delete-redundant', key: '05太极两仪生四象', origin: 'file',
  src: { path: '/lib/付费/玄关笔记/05.太极两仪生四象.mp3', name: '05.太极两仪生四象.mp3', size: 92986927, durationS: 5808 },
  basis: 'redundant-free-candidates:item:9068cb96b65f720c',
  candidateEpisodes: ['005.身边那些灵异事'],
}
const redundantExplain: RowExplain = {
  file: { path: '/lib/付费/玄关笔记/05.太极两仪生四象.mp3', sizeBytes: 92986927, durationS: 5808, kbps: 128 },
  edges: [
    edge('item:9068cb96b65f720c', '005.身边那些灵异事', 5808, [
      { kind: 'duration', state: 'hit', deltaS: 0, toleranceS: 1 },
      { kind: 'struct-key', key: 'epnum', value: '5' },
      { kind: 'name', method: 'sim', score: 0, cleanedLeft: '身边那些灵异事', cleanedRight: '太极两仪生四象', stripId: 'S0' },
    ], { vetoReason: 'below-threshold', rule: 'R9' }),
    edge('item:paidEpisode05', '05.太极两仪生四象', 2163, [
      { kind: 'struct-key', key: 'epnum', value: '5' },
      { kind: 'name', method: 'identity-exact', score: 1, cleanedLeft: '太极两仪生四象', cleanedRight: '太极两仪生四象', stripId: 'S0' },
      { kind: 'duration', state: 'contradict', deltaS: 3645, toleranceS: 1 },
    ], { vetoReason: 'duration-contradict' }),
  ],
  verdict: { rule: 'R13', disposition: 'asked' },
}

const valuesOf = (c: { signals: { label: string; value: string }[] } | null) =>
  Object.fromEntries((c?.signals ?? []).map((s) => [s.label, s.value]))

describe('duration-collision：问句的判据链', () => {
  it('三条信号：命中的两条 ok、卡住的那条 no', () => {
    const c = verdictChainOf(collideAction, collideExplain)
    expect(c?.signals.map((s) => [s.label, s.tone])).toEqual([
      ['集号', 'ok'], ['名字', 'ok'], ['时长', 'no'],
    ])
  })

  it('时长那条报出实测值、节目单值与差额——不是"差出量级"这种没有数的说法', () => {
    const v = valuesOf(verdictChainOf(collideAction, collideExplain))
    expect(v['时长']).toContain('53:14')       // 文件自己
    expect(v['时长']).toContain('59:11')       // 节目单那把尺
    expect(v['时长']).toContain('短 5 分 57 秒') // 357s，方向明说
  })

  /**
   * 活体 268 差 644 秒。按数值粗化的话它会报成"短 10 分钟"，而同一列里的 116（357 秒）报到秒
   * ——同一张面板上两把尺。问句里那 44 秒是有信息的（可能正是片头广告），不许抹掉。
   */
  it('差额再大也报到秒——问句这一列的精度必须一致', () => {
    const big = {
      ...collideExplain,
      file: { ...collideExplain.file, durationS: 2909 },
      edges: [{
        ...collideExplain.edges[0],
        episode: { ...collideExplain.edges[0].episode, durationS: 3553 },
        facts: [{ kind: 'duration', state: 'contradict', deltaS: 644, toleranceS: 1 } as MatchFact],
      }],
    }
    const act = { ...collideAction, src: { ...collideAction.src, durationS: 2909 } }
    expect(valuesOf(verdictChainOf(act, big))['时长']).toContain('短 10 分 44 秒')
  })

  it('名字全等说"完全一致"，并带上清洗后真正比过的那一串', () => {
    const v = valuesOf(verdictChainOf(collideAction, collideExplain))
    expect(v['名字']).toContain('安特卫普金库案')
    expect(v['名字']).toContain('完全一致')
  })

  it('集号来自 struct-key 事实，不是从文件名里现抠的', () => {
    expect(valuesOf(verdictChainOf(collideAction, collideExplain))['集号']).toBe('116')
  })

  it('解释归 hint，且不含任何行动句——那两句在按钮上', () => {
    const c = verdictChainOf(collideAction, collideExplain)
    expect(c?.hint).toBeTruthy()
    expect(c!.hint).not.toContain('挪去下架')
    expect(c!.hint).not.toContain('认领')
    expect(c!.hint).not.toContain('换正主')
  })
})

describe('delete-redundant：判删的判据链', () => {
  it('两条信号：时长命中的那集 ok、同名却对不上的那集 no', () => {
    const c = verdictChainOf(redundantAction, redundantExplain)
    expect(c?.signals.map((s) => [s.label, s.tone])).toEqual([['时长', 'ok'], ['同名集', 'no']])
  })

  it('时长那条点名命中的集，并说清有多准（deltaS=0 → 一秒不差）', () => {
    const v = valuesOf(verdictChainOf(redundantAction, redundantExplain))
    expect(v['时长']).toContain('96:48')
    expect(v['时长']).toContain('005.身边那些灵异事')
    expect(v['时长']).toContain('一秒不差')
  })

  /**
   * 这一条是整张卡最硬的证据，而现行文案一个字都没提：文件名写着「05.太极两仪生四象」，
   * 而节目单里那一集只有 36:03。用户读到"实际对应《005.身边那些灵异事》"时最想问的
   * 就是"凭什么"，答案正是这一行。
   */
  it('同名集那条报出它的时长与差额——回答"凭什么说这份不是它"', () => {
    const v = valuesOf(verdictChainOf(redundantAction, redundantExplain))
    expect(v['同名集']).toContain('05.太极两仪生四象')
    expect(v['同名集']).toContain('36:03')
    expect(v['同名集']).toContain('60 分钟')
  })

  it('结论点名那一集，并说出"源站放得出"这一环', () => {
    const c = verdictChainOf(redundantAction, redundantExplain)
    expect(c?.conclusion).toContain('005.身边那些灵异事')
    expect(c?.conclusion).toContain('源站')
  })

  /**
   * 多候选时机器**不知道**是哪一集，只知道"不论哪一集都该删"。措辞不许挑第一个说成"实际对应"——
   * 那是把推测伪装成结论，而这张卡后面接的是删除。
   */
  it('多候选：结论说"之一"，绝不点成某一集', () => {
    const multi: ReconcilePlanAction = {
      ...redundantAction,
      candidateEpisodes: ['756.大家都焦虑的这么具体了吗？', '857.影响伴侣关系的六个因素', '037.三谈身边灵异事'],
    }
    const c = verdictChainOf(multi, redundantExplain)
    expect(c?.conclusion).toContain('之一')
    expect(c?.conclusion).not.toContain('装的是《756')
  })

  /**
   * 结论里点名哪几集**只认后端的 `candidateEpisodes`**（与 `basis` 里那串 leftKey 逐位对齐），
   * 不认我从 explain 里 filter 出来的那批：explain 的边有 8 条上限、会被 `truncatedCount` 截断，
   * 拿它当权威名单迟早少列一集，而少列的那一集恰恰可能是"它其实不该删"的理由。
   */
  it('后端没给候选名单 → 整条链退让（返回 null），绝不拿 explain 自己凑一个', () => {
    const noList = { ...redundantAction, candidateEpisodes: undefined, episode: undefined }
    expect(verdictChainOf(noList, redundantExplain)).toBeNull()
  })
})

describe('码率异常：低得反常的那个数要自己冒出来', () => {
  /** 活体：157 个文件里 128k 有 150 个，异常的只有 29k 与 33k 两个——正是最可疑的那两份。 */
  it('低于基线四成 → 多一条 warn 信号', () => {
    const broken = { ...collideExplain, file: { ...collideExplain.file, kbps: 29 } }
    const c = verdictChainOf(collideAction, broken, { kbpsBaseline: 128 })
    const warn = c?.signals.find((s) => s.tone === 'warn')
    expect(warn?.label).toBe('码率')
    expect(warn?.value).toContain('29k')
    expect(warn?.value).toContain('128k')
  })

  it('正常码率不出这一条——每张卡都挂一行"码率正常"等于没说', () => {
    const c = verdictChainOf(collideAction, collideExplain, { kbpsBaseline: 128 })
    expect(c?.signals.some((s) => s.tone === 'warn')).toBe(false)
  })

  it('没有基线（老数据/样本太少）→ 不标，绝不拿绝对阈值猜', () => {
    const broken = { ...collideExplain, file: { ...collideExplain.file, kbps: 29 } }
    expect(verdictChainOf(collideAction, broken)?.signals.some((s) => s.tone === 'warn')).toBe(false)
  })

  describe('基线怎么来', () => {
    it('取中位数——平均数会被少数几个 320k 拉高，把正常的 128k 也打成异常', () => {
      expect(kbpsBaselineOf([...Array(150).fill(128), 29, 33, 192, 320, 320, 320, 320])).toBe(128)
    })

    it('样本太少 → 没有基线（几个文件谈不上"同批别的是多少"）', () => {
      expect(kbpsBaselineOf([29, 128, 320])).toBeUndefined()
    })
  })
})

/**
 * `evidence-conflict`（"到底是哪一集"）那张卡，以前**只给"都不是"这一半**，理由写在
 * `ReconcilePanel` 那条注释里：「让用户在一串集名里点一个同样是抓阄」。
 *
 * 那个顾虑是对的——**只要卡上真的只有一串集名**。判据链把每条边的证据摆到各自那一行上之后，
 * 选择就有依据了：哪一集时长命中、哪一集只是名字沾边，一眼分得出。所以这里产的不是"按钮"，
 * 是**每个候选各自的证据**；按钮能不能给，取决于这个函数拿不拿得出东西来。
 */
describe('候选集各自的证据：让"到底是哪一集"不再是抓阄', () => {
  const conflictExplain: RowExplain = {
    file: { path: '/lib/付费/37.申与酉.mp3', sizeBytes: 241804025, durationS: 6044, kbps: 320 },
    edges: [
      edge('item:A', '037.三谈身边灵异事', 6043, [
        { kind: 'duration', state: 'hit', deltaS: 1, toleranceS: 1 },
        { kind: 'struct-key', key: 'epnum', value: '37' },
        { kind: 'name', method: 'sim', score: 0, cleanedLeft: '三谈身边灵异事', cleanedRight: '申与酉', stripId: 'S0' },
      ], { vetoReason: 'below-threshold' }),
      edge('item:B', '756.大家都焦虑的这么具体了吗？', 6043, [
        { kind: 'duration', state: 'hit', deltaS: 1, toleranceS: 1 },
        { kind: 'name', method: 'sim', score: 0, cleanedLeft: '大家都焦虑的这么具体了吗？', cleanedRight: '申与酉', stripId: 'S0' },
      ], { vetoReason: 'below-threshold' }),
    ],
    verdict: { disposition: 'asked' },
  }

  it('逐个候选给出它自己命中了什么——两条并排就能比出谁的证据更硬', () => {
    const cs = conflictCandidatesOf(['item:A', 'item:B'], conflictExplain)
    expect(cs.map((c) => c.title)).toEqual(['037.三谈身边灵异事', '756.大家都焦虑的这么具体了吗？'])
    // A 多一条集号命中，B 没有——这正是用户挑得出的那个差别。
    expect(cs[0].evidence).toContain('集号 37')
    expect(cs[1].evidence).not.toContain('集号')
    expect(cs[0].evidence).toContain('时长只差 1 秒')
  })

  it('leftKey 原样带出——认领要拿它回传，绝不许前端按集名反查', () => {
    expect(conflictCandidatesOf(['item:B'], conflictExplain)[0].leftKey).toBe('item:B')
  })

  /**
   * 边被判决书截断（`truncatedCount`）时那一集在 `conflictsWith` 里有、在 `edges` 里没有。
   * **绝不许把它悄悄丢掉**：少列一集 = 用户在一个不完整的名单里做选择，而漏掉的那个可能正是答案。
   */
  it('判决书里查不到那条边 → 这一项照列，证据栏如实说"判决书里没有这条边"', () => {
    const cs = conflictCandidatesOf(['item:A', 'item:missing'], conflictExplain)
    expect(cs).toHaveLength(2)
    expect(cs[1].leftKey).toBe('item:missing')
    expect(cs[1].title).toBe('')          // 集名只能来自判决书，查不到就空着，绝不编一个
    expect(cs[1].evidence).toContain('判决书里没有这条边')
  })

  it('一条候选都拿不出来 → 空数组（调用方据此不给按钮，退回只有"都不是"的老样子）', () => {
    expect(conflictCandidatesOf([], conflictExplain)).toEqual([])
  })

  /**
   * 上一条是"名单空"，这一条是"**整份判决书都没有**"（老账本行）——两者结果一样但理由不同，
   * 而这一条的理由更硬：那时每一行都只剩一个光秃秃的 leftKey，摆出来让人点「就是它」
   * 就是回到抓阄，正是这张卡当初不给肯定式答案的原因。宁可退回只有"都不是"的老样子。
   */
  it('整份判决书缺席 → 空数组，绝不摆一排没有依据的候选让人点', () => {
    expect(conflictCandidatesOf(['item:A', 'item:B'], undefined)).toEqual([])
  })
})

describe('退让：没有判据链就退回原来那句话', () => {
  it('没有 explain（老账本行/豁免行）→ null', () => {
    expect(verdictChainOf(collideAction, undefined)).toBeNull()
  })

  it('explain 里没有对得上这张卡的边 → null，不渲染一条空链', () => {
    const empty: RowExplain = { ...collideExplain, edges: [] }
    expect(verdictChainOf(collideAction, empty)).toBeNull()
  })

  it('其余动作类别（move / replace / swap-hold）暂不产链，保持现状', () => {
    const move: ReconcilePlanAction = {
      kind: 'move', key: 'k', origin: 'authority',
      src: { path: '/a.mp3', name: 'a.mp3', size: 1, durationS: 10 }, dstDir: '/lib/下架', basis: 'authority:L1',
    }
    expect(verdictChainOf(move, collideExplain)).toBeNull()
  })
})
